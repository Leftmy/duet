use serde::{
    de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor},
    Deserializer,
};
use serde_json::{Map, Number, Value};
struct Seed<'a> {
    left: &'a mut usize,
    depth: usize,
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
        Ok(v.into())
    }
    fn visit_string<E: Error>(self, v: String) -> Result<Value, E> {
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
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            let value = a.next_value_seed(Seed {
                left: self.left,
                depth: self.depth + 1,
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
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let value = Seed {
        left: &mut left,
        depth: 0,
    }
    .deserialize(&mut d)
    .map_err(|e| e.to_string())?;
    d.end().map_err(|e| e.to_string())?;
    Ok(value)
}
