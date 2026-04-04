import Connection from "../index.js";

test("rejects if connection is not offline", () => {
  const conn = new Connection();
  conn.status = "online";
  return conn.start().catch((error) => {
    expect(error instanceof Error).toBe(true);
    expect(error.message).toBe("Connection is not offline");
  });
});
