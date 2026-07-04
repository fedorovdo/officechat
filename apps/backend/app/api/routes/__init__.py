from fastapi import APIRouter

from app.api.routes.admin_bots import router as admin_bots_router
from app.api.routes.admin_audit import router as admin_audit_router
from app.api.routes.admin_users import router as admin_users_router
from app.api.routes.admin_retention import router as admin_retention_router
from app.api.routes.auth import router as auth_router
from app.api.routes.bots import router as bots_router
from app.api.routes.cache import router as cache_router
from app.api.routes.db import router as db_router
from app.api.routes.direct import router as direct_router
from app.api.routes.discussions import router as discussions_router
from app.api.routes.groups import router as groups_router
from app.api.routes.presence import router as presence_router
from app.api.routes.system import router as system_router
from app.api.routes.users import router as users_router
from app.api.routes.ws import router as ws_router

api_router = APIRouter()
api_router.include_router(system_router, prefix="/system", tags=["system"])
api_router.include_router(db_router, tags=["infrastructure"])
api_router.include_router(cache_router, tags=["infrastructure"])
api_router.include_router(auth_router, prefix="/auth", tags=["auth"])
api_router.include_router(users_router, prefix="/users", tags=["users"])
api_router.include_router(bots_router, prefix="/bots", tags=["bots"])
api_router.include_router(direct_router, prefix="/direct", tags=["direct"])
api_router.include_router(discussions_router, prefix="/discussions", tags=["discussions"])
api_router.include_router(admin_bots_router, prefix="/admin/bots", tags=["admin"])
api_router.include_router(admin_audit_router, prefix="/admin/audit", tags=["admin", "audit"])
api_router.include_router(admin_users_router, prefix="/admin/users", tags=["admin"])
api_router.include_router(admin_retention_router, prefix="/admin", tags=["admin", "retention"])
api_router.include_router(groups_router, prefix="/groups", tags=["groups"])
api_router.include_router(presence_router, prefix="/presence", tags=["presence"])
api_router.include_router(ws_router, prefix="/ws", tags=["websocket"])
