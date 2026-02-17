import { toUiError } from "./errors.js";

async function parseApiResponse(response) {
  let payload = null;

  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    return toUiError(payload, response.status);
  }

  return payload;
}

export async function apiGet(path) {
  const response = await fetch(path, {
    credentials: "include"
  });
  return parseApiResponse(response);
}

export async function apiPost(path, data) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data)
  });
  return parseApiResponse(response);
}

export async function apiDelete(path) {
  const response = await fetch(path, {
    method: "DELETE",
    credentials: "include"
  });
  return parseApiResponse(response);
}
