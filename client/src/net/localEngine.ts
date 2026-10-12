/** The C# game engine (server/Gilli.Wasm) running in this browser as WebAssembly. */
export interface EngineExports {
  Layout(): string;
  Create(mode: string, name: string, difficulty: string, teamSize: number): string;
  Call(method: string, argsJson: string): string;
  Tick(dt: number): string;
  // peer-to-peer hosting
  CreateOnline(code: string, name: string): string;
  Join(name: string, connectionId: string): string;
  CallAs(playerId: string, method: string, argsJson: string): string;
  Disconnect(playerId: string): void;
}

/**
 * How online games run: 'server' = the C# multiplayer server (SignalR); 'p2p' = no server, the room creator's
 * browser hosts the C# room and friends connect peer-to-peer (Vercel builds set VITE_ONLINE=p2p).
 */
export const ONLINE_MODE: 'server' | 'p2p' = import.meta.env.VITE_ONLINE === 'p2p' ? 'p2p' : 'server';

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
