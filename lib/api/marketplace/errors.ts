import { NextResponse } from "next/server";

export function marketplaceError(
  status: number,
  code: string,
  description: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { error: code, status, error_description: description, ...extra },
    { status },
  );
}
