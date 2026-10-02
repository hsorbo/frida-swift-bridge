const MINIMUM_FRIDA = [17, 21, 0];

let resolver: ApiResolver | null = null;
let resolverModuleCount = -1;

// The resolver snapshots the loaded modules when made, so one made before a module loaded would
// not know that module's declarations: a changed module count makes a fresh one.
export function swiftMatches(query: string): ApiResolverMatch[] {
  const count = Process.enumerateModules().length;
  if (resolver === null || count !== resolverModuleCount) {
    requireFrida(MINIMUM_FRIDA);
    resolver = new ApiResolver("swift");
    resolverModuleCount = count;
  }
  return resolver.enumerateMatches(query);
}

function requireFrida(minimum: number[]): void {
  const running = Frida.version.split(".").map((part) => parseInt(part, 10));
  for (let i = 0; i < minimum.length; i++) {
    const have = running[i] ?? 0;
    if (have > minimum[i]) {
      return;
    }
    if (have < minimum[i]) {
      throw new Error(`frida-swift-bridge2 requires Frida ${minimum.join(".")} or newer, running ${Frida.version}`);
    }
  }
}
