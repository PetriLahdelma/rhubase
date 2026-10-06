use crate::{
    error::{AppError, Result},
    paths::sha256_bytes,
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::{collections::HashSet, fmt};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<'a> {
    pub protocol_version: u32,
    pub request_id: &'a str,
    pub method: &'static str,
    pub params: Params<'a>,
}
#[derive(Debug, Serialize)]
pub struct Params<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub compiler: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    protocol_version: u32,
    request_id: Option<String>,
    ok: bool,
    result: Option<Value>,
    error: Option<WorkerError>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerError {
    code: String,
    message: String,
}

pub enum Outcome {
    Success(Value),
    Failure { code: String, message: String },
}

struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}
struct StrictVisitor;
impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON without duplicate object keys")
    }
    fn visit_bool<E>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E>(self, v: String) -> std::result::Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_none<E>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_unit<E>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = seq.next_element()? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut result = Map::new();
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(serde::de::Error::custom("duplicate JSON key"));
            }
            let StrictValue(value) = map.next_value()?;
            result.insert(key, value);
        }
        Ok(Value::Object(result))
    }
}

pub fn request_id(seed: &[u8]) -> String {
    sha256_bytes(seed)
}
pub fn encode_request<'a>(
    request_id: &'a str,
    from: &'a str,
    to: &'a str,
    compiler: &'a str,
) -> Result<Vec<u8>> {
    if request_id.len() != 64
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(AppError::new("invalid request ID"));
    }
    let value = Request {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        method: "infer",
        params: Params { from, to, compiler },
    };
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(AppError::new("worker request exceeds 64 KiB"));
    }
    Ok(bytes)
}

pub fn encode_method_request(request_id: &str, method: &str, params: Value) -> Result<Vec<u8>> {
    if request_id.len() != 64
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(AppError::new("invalid request ID"));
    }
    let value = serde_json::json!({"protocolVersion":PROTOCOL_VERSION,"requestId":request_id,"method":method,"params":params});
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(AppError::new("worker request exceeds 64 KiB"));
    }
    Ok(bytes)
}

pub fn decode_envelope(bytes: &[u8], expected_id: &str) -> Result<Outcome> {
    if bytes.len() < 2 || bytes.last() != Some(&b'\n') {
        return Err(AppError::new(
            "worker envelope must end with exactly one LF",
        ));
    }
    let body = &bytes[..bytes.len() - 1];
    if body.contains(&b'\n') || body.contains(&b'\r') {
        return Err(AppError::new(
            "worker envelope must be one JSON line with LF framing",
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let StrictValue(value) = StrictValue::deserialize(&mut deserializer)
        .map_err(|e| AppError::new(format!("invalid worker JSON: {e}")))?;
    deserializer
        .end()
        .map_err(|e| AppError::new(format!("trailing worker output: {e}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::new("worker envelope must be an object"))?;
    let expected = if object.get("ok") == Some(&Value::Bool(true)) {
        ["ok", "protocolVersion", "requestId", "result"].as_slice()
    } else {
        ["error", "ok", "protocolVersion", "requestId"].as_slice()
    };
    if object.len() != expected.len() || !expected.iter().all(|key| object.contains_key(*key)) {
        return Err(AppError::new("worker envelope fields do not match outcome"));
    }
    let envelope: Envelope = serde_json::from_value(value)
        .map_err(|e| AppError::new(format!("invalid worker envelope: {e}")))?;
    if envelope.protocol_version != PROTOCOL_VERSION
        || envelope.request_id.as_deref() != Some(expected_id)
    {
        return Err(AppError::new("worker protocol correlation mismatch"));
    }
    match (envelope.ok, envelope.result, envelope.error) {
        (true, Some(result), None) => Ok(Outcome::Success(result)),
        (false, None, Some(error))
            if valid_error_code(&error.code)
                && !error.message.is_empty()
                && error.message.len() <= 1000
                && !error.message.contains(['\r', '\n']) =>
        {
            Ok(Outcome::Failure {
                code: error.code,
                message: error.message,
            })
        }
        _ => Err(AppError::new("worker envelope result/error shape mismatch")),
    }
}
fn valid_error_code(value: &str) -> bool {
    [
        "invalid-json",
        "input-too-large",
        "invalid-request",
        "unsupported-version",
        "unsupported-method",
        "unsafe-environment",
        "inference-failed",
        "output-too-large",
        "serialization-failed",
        "resolution-failed",
        "assessment-failed",
    ]
    .contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID: &[u8] = b"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"ok\":true,\"result\":{}}\n";
    #[test]
    fn duplicate_nested_key_fails() {
        assert!(decode_envelope(b"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"ok\":true,\"result\":{\"a\":1,\"a\":2}}\n", &"a".repeat(64)).is_err());
    }
    #[test]
    fn trailing_fails() {
        assert!(decode_envelope(b"{} trailing", &"a".repeat(64)).is_err());
    }
    #[test]
    fn missing_lf_fails() {
        assert!(decode_envelope(&VALID[..VALID.len() - 1], &"a".repeat(64)).is_err());
    }
    #[test]
    fn double_lf_fails() {
        let mut bytes = VALID.to_vec();
        bytes.push(b'\n');
        assert!(decode_envelope(&bytes, &"a".repeat(64)).is_err());
    }
    #[test]
    fn crlf_fails() {
        let mut bytes = VALID[..VALID.len() - 1].to_vec();
        bytes.extend_from_slice(b"\r\n");
        assert!(decode_envelope(&bytes, &"a".repeat(64)).is_err());
    }
}
