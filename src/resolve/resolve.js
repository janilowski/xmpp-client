import * as http from "./lib/http.js";

export default async function resolve(...args) {
  return http.resolve(...args);
}

export { http };
