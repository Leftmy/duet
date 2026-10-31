//! Codex approval contracts. Grants are always a subset of the server request.
use super::events::{arr, s};
use serde_json::{json, Value};
pub fn permissions(request: &Value, reply: &Value) -> Value {
    let mut granted = json!({});
    if matches!(s(reply, "decision"), "allow" | "always") {
        for key in ["network", "fileSystem"] {
            if let Some(value) = request["permissions"].get(key).filter(|v| !v.is_null()) {
                granted[key] = value.clone();
            }
        }
    }
    json!({"permissions":granted,"scope":if reply["decision"]=="always"{"session"}else{"turn"}})
}
pub fn questions(request: &Value) -> Value {
    json!(arr(&request["questions"]).iter().map(|q|json!({"id":q["id"],"question":q["question"],"header":q["header"],"multiSelect":false,"isSecret":q["isSecret"]==true,"isOther":q["isOther"]==true,"options":arr(&q["options"])})).collect::<Vec<_>>())
}
pub fn answers(request: &Value, reply: &Value) -> Value {
    let mut answers = json!({});
    if reply["decision"] != "deny" {
        for q in arr(&request["questions"]) {
            let id = s(q, "id");
            let values = if let Some(values) = reply["updatedInput"]["answerValues"][id].as_array()
            {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            } else {
                reply["updatedInput"]["answers"]
                    .get(id)
                    .or_else(|| reply["updatedInput"]["answers"].get(s(q, "question")))
                    .and_then(Value::as_str)
                    .map(|v| vec![v.into()])
                    .unwrap_or_default()
            };
            answers[id] = json!({"answers":values});
        }
    }
    json!({"answers":answers})
}
pub fn validate_form(schema: &Value, value: &Value) -> Result<(), String> {
    fn check(schema: &Value, value: &Value, depth: usize) -> Result<(), String> {
        if depth > 16 {
            return Err("MCP form is too deeply nested".into());
        }
        if let Some(choices) = schema["enum"].as_array() {
            if !choices.contains(value) {
                return Err("Choose a value from the supplied options".into());
            }
        }
        if let Some(constant) = schema.get("const") {
            if constant != value {
                return Err("Value does not match the requested constant".into());
            }
        }
        if let Some(choices) = schema["oneOf"].as_array() {
            if choices
                .iter()
                .filter(|c| check(c, value, depth + 1).is_ok())
                .count()
                != 1
            {
                return Err("Value does not match the requested schema".into());
            }
        }
        if let Some(choices) = schema["anyOf"].as_array() {
            if !choices.iter().any(|c| check(c, value, depth + 1).is_ok()) {
                return Err("Value does not match any allowed type".into());
            }
        }
        for child in arr(&schema["allOf"]) {
            check(child, value, depth + 1)?;
        }
        if let Some(types) = schema["type"].as_array() {
            let mut valid = false;
            for ty in types {
                let mut part = schema.clone();
                part["type"] = ty.clone();
                if check(&part, value, depth + 1).is_ok() {
                    valid = true;
                    break;
                }
            }
            return if valid {
                Ok(())
            } else {
                Err("Value has an invalid type".into())
            };
        }
        match s(schema, "type") {
            "object" => {
                let object = value.as_object().ok_or("Expected an object")?;
                for key in arr(&schema["required"]).iter().filter_map(Value::as_str) {
                    if !object.contains_key(key) {
                        return Err(format!("Required field: {key}"));
                    }
                }
                for (key, value) in object {
                    if let Some(field) = schema["properties"].get(key) {
                        check(field, value, depth + 1).map_err(|e| format!("{key}: {e}"))?;
                    } else if schema["additionalProperties"] == false {
                        return Err(format!("Unexpected field: {key}"));
                    }
                }
            }
            "array" => {
                let array = value.as_array().ok_or("Expected an array")?;
                if array.len() > 1000 {
                    return Err("Too many form values".into());
                }
                if schema["minItems"]
                    .as_u64()
                    .is_some_and(|n| array.len() < (n as usize))
                    || schema["maxItems"]
                        .as_u64()
                        .is_some_and(|n| array.len() > (n as usize))
                {
                    return Err("Array size is outside the requested range".into());
                }
                if schema["uniqueItems"] == true {
                    for (i, v) in array.iter().enumerate() {
                        if array[..i].contains(v) {
                            return Err("Duplicate values".into());
                        }
                    }
                }
                for item in array {
                    if schema["items"].is_object() {
                        check(&schema["items"], item, depth + 1)?;
                    }
                }
            }
            "null" if !value.is_null() => return Err("Expected null".into()),
            "boolean" if !value.is_boolean() => return Err("Expected a boolean".into()),
            "number" | "integer" => {
                let n = value.as_f64().ok_or("Expected a number")?;
                if schema["type"] == "integer" && n.fract() != 0. {
                    return Err("Expected an integer".into());
                }
                if schema["minimum"].as_f64().is_some_and(|min| n < min)
                    || schema["maximum"].as_f64().is_some_and(|max| n > max)
                {
                    return Err("Number is outside the requested range".into());
                }
            }
            "string" => {
                let text = value.as_str().ok_or("Expected text")?;
                if text.len() > 131072 {
                    return Err("Form text is too large".into());
                }
                let n = text.chars().count();
                if schema["minLength"]
                    .as_u64()
                    .is_some_and(|min| n < (min as usize))
                    || schema["maxLength"]
                        .as_u64()
                        .is_some_and(|max| n > (max as usize))
                {
                    return Err("Text length is outside the requested range".into());
                }
                if let Some(pattern) = schema["pattern"].as_str() {
                    if pattern.len() > 4096 {
                        return Err("Form pattern is too large".into());
                    }
                    if !regex::Regex::new(pattern)
                        .map_err(|_| "Unsupported form validation pattern")?
                        .is_match(text)
                    {
                        return Err("Text does not match the requested format".into());
                    }
                }
                if schema["format"] == "uri" && url::Url::parse(text).is_err() {
                    return Err("Expected a URL".into());
                }
            }
            _ => {}
        }
        Ok(())
    }
    check(schema, value, 0)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_turns_do_not_finish_a_completed_successor_or_restart_it() {
        let mut translator = super::super::events::CodexTranslator::default();
        translator.retire_turn("old");
        translator.turn = Some("new".into());
        let done = translator.push(
            "turn/completed",
            &json!({"threadId":"root","turn":{"id":"new","status":"completed"}}),
            "root",
        );
        assert!(done.iter().any(|e| e["type"] == "turn.end"));
        for method in ["turn/completed", "turn/started"] {
            assert!(translator
                .push(
                    method,
                    &json!({"threadId":"root","turn":{"id":"old","status":"completed"}}),
                    "root"
                )
                .is_empty());
        }
        assert!(translator.turn.is_none());
    }
    #[test]
    fn only_definite_no_active_turn_rejections_allow_a_successor() {
        assert!(no_active_turn("Invalid request: No active turn"));
        assert!(!no_active_turn("CLI request timed out"));
        assert!(!no_active_turn("Invalid skill reference"));
    }
    #[test]
    fn review_worker_turn_does_not_replace_outer_review_id() {
        use crate::core::events::CodexTranslator;
        let mut t = CodexTranslator::default();
        t.push("item/started",&json!({"threadId":"lead","turnId":"outer","item":{"type":"enteredReviewMode","id":"enter","review":"Review"}}),"lead");
        t.push(
            "turn/started",
            &json!({"threadId":"lead","turn":{"id":"worker"}}),
            "lead",
        );
        assert_eq!(t.turn.as_deref(), Some("outer"));
        let result = t.push(
            "turn/completed",
            &json!({"threadId":"lead","turn":{"id":"outer","status":"completed"}}),
            "lead",
        );
        assert_eq!(result.len(), 1);
        assert!(t.review_turn.is_none());
    }
    #[test]
    fn completed_turns_do_not_finish_a_successor_or_repeat() {
        use crate::core::events::CodexTranslator;
        let mut translator = CodexTranslator::default();
        translator.push(
            "turn/started",
            &json!({"threadId":"lead","turn":{"id":"compact"}}),
            "lead",
        );
        let end = json!({"threadId":"lead","turn":{"id":"compact","status":"completed"}});
        assert_eq!(translator.push("turn/completed", &end, "lead").len(), 1);
        translator.push(
            "turn/started",
            &json!({"threadId":"lead","turn":{"id":"review"}}),
            "lead",
        );
        assert!(translator.push("turn/completed", &end, "lead").is_empty());
        assert_eq!(translator.turn.as_deref(), Some("review"));
        let review = json!({"threadId":"lead","turn":{"id":"review","status":"completed"}});
        assert_eq!(translator.push("turn/completed", &review, "lead").len(), 1);
        assert!(translator
            .push("turn/completed", &review, "lead")
            .is_empty());
    }
    #[test]
    fn translates_codex_plan_progress_review_and_async_questions() {
        use crate::core::events::{codex_item, CodexTranslator};
        let mut translator = CodexTranslator::default();
        assert_eq!(
            translator.push(
                "item/plan/delta",
                &json!({"threadId":"lead","itemId":"plan","delta":"Plan text"}),
                "lead"
            )[0]["text"],
            "Plan text"
        );
        assert_eq!(
            translator.push(
                "item/fileChange/outputDelta",
                &json!({"threadId":"lead","itemId":"patch","delta":"output"}),
                "lead"
            )[0]["chunk"],
            "output"
        );
        assert_eq!(
            translator.push(
                "thread/goal/updated",
                &json!({"threadId":"lead","goal":{"objective":"User goal"}}),
                "lead"
            )[0]["state"]["goal"]["objective"],
            "User goal"
        );
        let question = codex_item(
            &json!({"type":"agentMessage","id":"q","text":"","questions":[{"title":"Choose","options":["A","B"]}]}),
            true,
            None,
        );
        assert_eq!(
            question[1]["state"]["questions"]["items"][0]["title"],
            "Choose"
        );
        let review = codex_item(
            &json!({"type":"exitedReviewMode","id":"review","review":json!({"findings":[{"title":"Fix issue","body":"Explanation","code_location":{"absolute_file_path":"C:/project/main.rs","line_range":{"start":12}}}],"overall_explanation":"Summary"}).to_string()}),
            true,
            None,
        );
        assert!(review[0]["text"]
            .as_str()
            .unwrap()
            .contains("(<C:/project/main.rs:12>)"));
    }
    #[test]
    fn grant_only_requested_permissions() {
        let req = json!({"permissions":{"network":{"enabled":true},"fileSystem":null}});
        assert_eq!(
            permissions(&req, &json!({"decision":"deny"})),
            json!({"permissions":{},"scope":"turn"})
        );
        assert_eq!(
            permissions(
                &req,
                &json!({"decision":"always","updatedInput":{"fileSystem":{"write":["/"]}}})
            ),
            json!({"permissions":{"network":{"enabled":true}},"scope":"session"})
        );
    }
    #[test]
    fn question_answers_keep_commas_and_ids() {
        let req =
            json!({"questions":[{"id":"q1","question":"Same"},{"id":"q2","question":"Same"}]});
        let reply = json!({"decision":"allow","updatedInput":{"answerValues":{"q1":["one, two"],"q2":["three"]}}});
        assert_eq!(
            answers(&req, &reply),
            json!({"answers":{"q1":{"answers":["one, two"]},"q2":{"answers":["three"]}}})
        );
    }
    #[test]
    fn validate_required_typed_form_values() {
        let schema = json!({"type":"object","required":["name","count"],"properties":{"name":{"type":"string","minLength":2},"count":{"type":"integer","minimum":1},"mode":{"type":"string","enum":["read","write"]}}});
        assert!(validate_form(&schema, &json!({"name":"ok","count":2,"mode":"read"})).is_ok());
        for v in [
            json!({"name":"ok"}),
            json!({"name":"x","count":2}),
            json!({"name":"ok","count":1.2}),
            json!({"name":"ok","count":2,"mode":"root"}),
        ] {
            assert!(validate_form(&schema, &v).is_err())
        }
    }
}
/// Only a definite rejection before input acceptance permits starting a successor turn.
pub(super) fn no_active_turn(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("no active turn") || error.contains("no turn is currently active")
}
