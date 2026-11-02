import { NextResponse } from "next/server";

export function notFound(description: string): NextResponse {
  return NextResponse.json(
    { error: "not_found", status: 404, error_description: description },
    { status: 404 },
  );
}
