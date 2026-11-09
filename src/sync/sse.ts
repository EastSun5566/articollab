/** One dispatched server-sent event. */
export interface ServerSentEvent {
  readonly type: string;
  readonly data: string;
  readonly id: string | undefined;
}

/**
 * Reads a `text/event-stream` body as the HTML standard defines: lines end in CRLF, LF or CR,
 * comments start with a colon, and an event is dispatched at a blank line. A trailing event
 * without its blank line is discarded. `onActivity` runs for every complete line, comments included.
 */
export async function readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerSentEvent) => void,
  onActivity: () => void = () => {}
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let type = "";
  let data: string[] = [];
  let id: string | undefined;
  let seenCarriageReturn = false;

  function line(text: string): void {
    onActivity();
    if (text === "") {
      if (data.length > 0) onEvent({ type: type === "" ? "message" : type, data: data.join("\n"), id });
      type = ""; data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }); // Keeps multi-byte characters split across chunks.
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index];
      if (char === "\n" && seenCarriageReturn && index === start) { start = index + 1; seenCarriageReturn = false; continue; }
      seenCarriageReturn = false;
      if (char !== "\n" && char !== "\r") continue;
      line(buffer.slice(start, index));
      start = index + 1;
      // A CR may be the first half of a CRLF split across chunks.
      seenCarriageReturn = char === "\r";
    }
    buffer = buffer.slice(start);
  }
}
