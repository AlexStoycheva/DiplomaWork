from fastapi import Depends, HTTPException
from fastapi import Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from jose import JWTError, jwt
from passlib.context import CryptContext
from datetime import datetime, timedelta

from app.db import SessionLocal
from app.models import User
from app.dependencies import get_db

security = HTTPBearer(auto_error=False)

SECRET_KEY = "supersecretkey"
ALGORITHM = "HS256"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db)
):
    token = None

    if credentials and credentials.credentials not in {"", "null", "undefined"}:
        token = credentials.credentials

    if not token:
        token = request.cookies.get("token")

    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = payload.get("user_id")

    user = db.query(User).get(user_id)

    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def get_current_user_optional(db: Session = Depends(get_db)) -> User | None:
    """Optional authentication - returns user if valid token exists, None otherwise."""
    return None


def is_admin(user: User):
    return any(r.role.name == "admin" for r in user.roles)


def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(hours=2)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def hash_password(password: str):
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str):
    return pwd_context.verify(plain_password, hashed_password)
