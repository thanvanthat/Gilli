/** The C# game engine (server/Gilli.Wasm) running in this browser as WebAssembly. */
export interface EngineExports {
  Layout(): string;
  Create(mode: string, name: string, difficulty: string, teamSize: number): string;
  Call(method: string, argsJson: string): string;
  Tick(dt: number): string;
}

/** False when the site is deployed without the multiplayer server (e.g. Vercel only). */
export const ONLINE_ENABLED = import.meta.env.VITE_ONLINE !== 'off';

let loading: Promise<EngineExports> | null = null;

/** Loads the .NET WebAssembly runtime and the engine once (built into public/engine by `npm run build:engine`). */
export function loadEngine(): Promise<EngineExports> {
  loading ??= (async () => {
    const url = `${import.meta.env.BASE_URL}engine/_framework/dotnet.js`;
    const { dotnet } = await import(/* @vite-ignore */ url);
    const runtime = await dotnet.create();
    const exports = await runtime.getAssemblyExports('Gilli.Wasm.dll');
    return exports.Engine as EngineExports;
  })();
  loading.catch(() => { loading = null; }); // allow a retry after a failed download
  return loading;
}
