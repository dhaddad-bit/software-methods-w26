import { apiGet } from './api/api.js'

export async function getCurrentUser() {
    const res = await apiGet("/api/me");
    if (res && res.error) return null;
    return res;
}
