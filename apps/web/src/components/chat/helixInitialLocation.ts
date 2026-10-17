// Only the first attachment can rely on the launcher's initial location.
// Later panes must reveal their requested file, because HX may have moved.
const initialLocations = new Map<string, string>();

export function rememberHelixInitialLocation(terminalId: string, location: string): void {
  initialLocations.set(terminalId, location);
}

export function takeHelixInitialLocation(terminalId: string): string | undefined {
  const location = initialLocations.get(terminalId);
  initialLocations.delete(terminalId);
  return location;
}
