const named = (route) => typeof route === "string" && route.trim() !== "";
const knownMachine = (space) => space && (space.machine === null || named(space.machine));
const one = (matches) => matches.length === 1 ? matches[0] : undefined;

export function focusScope(spaces, focus, terminals) {
  const activeSpaces = spaces.filter((space) => space.active === true);
  const active = one(activeSpaces);
  const activeMachine = knownMachine(active) ? active.machine : undefined;
  if (named(activeMachine)) return { activeMachine, session: "remote", terminal: null };
  const unknown = { activeMachine, session: "unknown", terminal: null };
  if (activeMachine !== null || (focus && active.id !== focus.space)) return unknown;
  const address = focus?.terminal ?? focus?.agent;
  // Herdr publishes bare local terminal addresses and machine/address for remotes.
  if ([address, focus?.shown].some((value) => named(value) && value.includes("/"))) {
    return { activeMachine, session: "remote", terminal: null };
  }
  if (address != null && (!named(address) || !one(terminals().filter((row) => row.address === address)))) return unknown;
  return { activeMachine, session: "local", terminal: address ?? null };
}

export const selectable = (machine) => machine?.registered === true && machine.enabled && machine.availability === "ready";
