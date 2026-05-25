from pydantic import BaseModel

from app.schemas.user import UserPublic


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


class LogoutResponse(BaseModel):
    status: str = "ok"
