import { expect, it, vi } from "vitest";

import { resetAdminUserPassword } from "../lib/api";
import { userFactory } from "./factories";

it("posts the new password to the selected admin user reset endpoint", async () => {
  const target = userFactory({ id: "00000000-0000-4000-8000-000000000101" });
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(target), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  );
  vi.stubGlobal("fetch", fetchMock);

  await resetAdminUserPassword("test-token", target.id, "temporary-password-123");

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`/api/admin/users/${target.id}/reset-password`);
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ new_password: "temporary-password-123" });
});
