import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "officechat-frontend",
    version: process.env.NEXT_PUBLIC_OFFICECHAT_VERSION ?? "0.1.0-rc1"
  });
}
