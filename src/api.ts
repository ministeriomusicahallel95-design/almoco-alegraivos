export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: { method?: string; body?: any; token?: string; csrf?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(
      'Sem conexão com o serviço. Consulte o pedido novamente antes de fazer outro.',
      0,
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      data?.error || 'Não foi possível concluir. Tente novamente.',
      response.status,
    );
  return data;
}
export type Access = { id: string; token: string };
const key = 'hallel-reservas-v1';
export function saved(): Access[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (v) =>
              typeof v.id === 'string' &&
              /^[a-f0-9-]{36}$/.test(v.id) &&
              /^[a-f0-9]{64}$/.test(v.token),
          )
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}
export function saveAccess(access: Access) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify([access, ...saved().filter((v) => v.id !== access.id)].slice(0, 20)),
    );
  } catch {}
}
export function newAccess(): Access {
  return {
    id: crypto.randomUUID(),
    token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join(''),
  };
}
