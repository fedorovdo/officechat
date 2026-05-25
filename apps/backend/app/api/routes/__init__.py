from fastapi import APIRouter

from app.api.routes.cache import router as cache_router
from app.api.routes.db import router as db_router
from app.api.routes.system import router as system_router

api_router = APIRouter()
api_router.include_router(system_router, prefix="/system", tags=["system"])
api_router.include_router(db_router, tags=["infrastructure"])
api_router.include_router(cache_router, tags=["infrastructure"])
