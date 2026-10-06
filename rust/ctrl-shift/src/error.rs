use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub struct AppError {
    pub message: String,
    pub exit: i32,
}

impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit: 1,
        }
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit: 2,
        }
    }
    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit: 124,
        }
    }
    pub fn interrupted(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit: 130,
        }
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::new(value.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::new(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
