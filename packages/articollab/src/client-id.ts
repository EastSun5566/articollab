/** Returns the allocation number only for server-issued canonical client IDs. */
export function clientNumber(clientId: string): number | undefined {
  if (typeof clientId !== "string" || !/^client-[1-9]\d*$/.test(clientId)) return undefined;
  const number = Number(clientId.slice(7));
  return Number.isSafeInteger(number) && clientId === `client-${number}`
    ? number
    : undefined;
}
