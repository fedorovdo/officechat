import argparse
import asyncio
import getpass
import json
import os
import sys

from sqlalchemy.exc import IntegrityError

from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.services.deleted_attachment_cleanup import cleanup_deleted_message_attachments
from app.services.security import hash_password
from app.services.users import get_user_by_username, normalize_username


def _read_password(args: argparse.Namespace) -> str:
    if args.password_file:
        with open(args.password_file, "r", encoding="utf-8") as password_file:
            return password_file.read().strip()
    if args.password_stdin:
        return sys.stdin.read().strip()
    env_password = os.getenv("OFFICECHAT_ADMIN_PASSWORD")
    if env_password:
        return env_password
    return getpass.getpass("Admin password: ").strip()


async def _create_admin(args: argparse.Namespace) -> int:
    username = normalize_username(args.username)
    display_name = args.display_name.strip()
    password = _read_password(args)

    if not username:
        print("Username must not be empty", file=sys.stderr)
        return 2
    if not display_name:
        print("Display name must not be empty", file=sys.stderr)
        return 2
    if len(password) < 8:
        print("Password must contain at least 8 characters", file=sys.stderr)
        return 2

    async with AsyncSessionLocal() as session:
        existing_user = await get_user_by_username(session, username)
        if existing_user:
            print(f"User '{username}' already exists; no changes made.")
            return 0

        user = User(
            username=username,
            display_name=display_name,
            email=None,
            password_hash=hash_password(password),
            role="superadmin",
            is_active=True,
            is_system=False,
            auth_provider="local",
        )
        session.add(user)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            print(f"User '{username}' already exists; no changes made.")
            return 0

    print(f"Superadmin '{username}' created.")
    return 0


async def _cleanup_deleted_attachments(args: argparse.Namespace) -> int:
    async with AsyncSessionLocal() as session:
        report = await cleanup_deleted_message_attachments(session, apply=args.apply)
    print(json.dumps(report.as_dict(), sort_keys=True))
    return 1 if report.errors else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="OfficeChat maintenance CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_admin = subparsers.add_parser("create-admin", help="Create a local superadmin if it does not exist")
    create_admin.add_argument("--username", required=True)
    create_admin.add_argument("--display-name", required=True)
    password_source = create_admin.add_mutually_exclusive_group()
    password_source.add_argument("--password-file")
    password_source.add_argument("--password-stdin", action="store_true")
    create_admin.set_defaults(handler=_create_admin)

    cleanup_attachments = subparsers.add_parser(
        "cleanup-deleted-attachments",
        help="Report or remove files attached to soft-deleted messages",
    )
    cleanup_attachments.add_argument(
        "--apply",
        action="store_true",
        help="Disable attachment records and delete files; default is dry-run",
    )
    cleanup_attachments.set_defaults(handler=_cleanup_deleted_attachments)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return asyncio.run(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
