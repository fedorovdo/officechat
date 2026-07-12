import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "officechat-frontend",
    product: process.env.NEXT_PUBLIC_OFFICECHAT_PRODUCT_NAME ?? "OfficeChat",
    version: process.env.NEXT_PUBLIC_OFFICECHAT_VERSION ?? "0.1.0-rc1",
    build_sha: process.env.NEXT_PUBLIC_OFFICECHAT_BUILD_SHA?.slice(0, 12) || undefined,
    build_date: process.env.NEXT_PUBLIC_OFFICECHAT_BUILD_DATE || undefined
  });
}
