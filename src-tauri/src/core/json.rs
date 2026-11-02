use serde::{
    de::{DeserializeSeed, Error, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserializer,
};
use serde_json::{Map, Number, Value};
struct Seed<'a> {
    left: &'a mut usize,
    bytes: &'a mut usize,
    depth: usize,
    scope: Scope,
}
#[derive(Clone, Copy)]
enum Scope {
    Other,
    Envelope,
    Reply,
    Params,
    Thread,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        if *self.left == 0 || self.depth > 64 {
            return Err(D::Error::custom("JSON object/depth budget exceeded"));
        }
        *self.left -= 1;
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a bounded JSON value")
    }
    fn visit_bool<E: Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: Error>(self, v: i64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: Error>(self, v: u64) -> Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: Error>(self, v: f64) -> Result<Value, E> {
        Ok(Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }
    fn visit_str<E: Error>(self, v: &str) -> Result<Value, E> {
        if v.len() > *self.bytes {
            return Err(E::custom("JSON string budget exceeded"));
        }
        *self.bytes -= v.len();
        Ok(v.into())
    }
    fn visit_string<E: Error>(self, v: String) -> Result<Value, E> {
        if v.len() > *self.bytes {
            return Err(E::custom("JSON string budget exceeded"));
        }
        *self.bytes -= v.len();
        Ok(v.into())
    }
    fn visit_none<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = a.next_element_seed(Seed {
            left: self.left,
            bytes: self.bytes,
            depth: self.depth + 1,
            scope: Scope::Other,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if key.len() > *self.bytes {
                return Err(A::Error::custom("JSON key budget exceeded"));
            }
            *self.bytes -= key.len();
            // Codex returns the entire transcript when resuming/forking a thread.
            // History is already paged from its journal; never duplicate it in live RPC.
            if matches!(self.scope, Scope::Thread) && key == "turns" {
                a.next_value::<IgnoredAny>()?;
                values.insert(key, Value::Array(Vec::new()));
                continue;
            }
            let scope = match (self.scope, key.as_str()) {
                (Scope::Envelope, "result") => Scope::Reply,
                (Scope::Envelope, "params") => Scope::Params,
                (Scope::Reply | Scope::Params, "thread") => Scope::Thread,
                _ => Scope::Other,
            };
            let value = a.next_value_seed(Seed {
                left: self.left,
                bytes: self.bytes,
                depth: self.depth + 1,
                scope,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > super::jsonl::MAX_RECORD {
        return Err("JSON record exceeds byte budget".into());
    }
    let mut left = 100000;
    let mut budget = super::jsonl::MAX_RECORD;
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let value = Seed {
        left: &mut left,
        bytes: &mut budget,
        depth: 0,
        scope: Scope::Other,
    }
    .deserialize(&mut d)
    .map_err(|e| e.to_string())?;
    d.end().map_err(|e| e.to_string())?;
    Ok(value)
}

/// Live envelopes may include hundreds of MB of redundant saved turns. Skip only
/// the protocol's thread history; actual tool results and normal history reads stay intact.
pub fn parse_cli_reader(reader: impl std::io::Read) -> Result<Value, String> {
    let mut left = 100000;
    let mut bytes = 128 * 1024 * 1024;
    let mut d = serde_json::Deserializer::from_reader(reader);
    let value = Seed {
        left: &mut left,
        bytes: &mut bytes,
        depth: 0,
        scope: Scope::Envelope,
    }
    .deserialize(&mut d)
    .map_err(|e| e.to_string())?;
    d.end().map_err(|e| e.to_string())?;
    Ok(value)
}
pub fn parse_cli(bytes: &[u8]) -> Result<Value, String> {
    let mut left = 100000;
    let mut budget = 128 * 1024 * 1024;
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let value = Seed {
        left: &mut left,
        bytes: &mut budget,
        depth: 0,
        scope: Scope::Envelope,
    }
    .deserialize(&mut d)
    .map_err(|e| e.to_string())?;
    d.end().map_err(|e| e.to_string())?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_projection_preserves_metadata_and_business_data_without_altering_history_parser() {
        let raw=br#"{"result":{"thread":{"id":"same","turns":[{"id":"old"}],"status":{"type":"idle"}},"business":{"thread":{"turns":[1,2]}}},"id":7}"#;
        let v = parse_cli(raw).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["thread"]["id"], "same");
        assert_eq!(v["result"]["thread"]["turns"], serde_json::json!([]));
        assert_eq!(
            v["result"]["business"]["thread"]["turns"],
            serde_json::json!([1, 2])
        );
        assert_eq!(
            parse(raw).unwrap()["result"]["thread"]["turns"][0]["id"],
            "old"
        );
        assert!(parse_cli(br#"{"result":{"thread":{"turns":[invalid]}}}"#).is_err());
    }
}
