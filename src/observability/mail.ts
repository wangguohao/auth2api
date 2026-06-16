import net from "net";
import tls from "tls";
import { MailConfig } from "../config";

type Socket = net.Socket | tls.TLSSocket;

function base64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64");
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractEmail(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] || value).trim();
}

function buildMessage(
  from: string,
  recipients: string[],
  subject: string,
  body: string,
): string {
  const encodedSubject = `=?UTF-8?B?${base64(subject)}?=`;
  const html = `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap;">${htmlEscape(body)}</pre>`;
  return [
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
  ].join("\r\n");
}

class SmtpSession {
  private socket: Socket;
  private buffer = "";

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.setEncoding("utf-8");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
    });
  }

  async expect(...codes: number[]): Promise<string> {
    const text = await this.readResponse();
    const code = Number(text.slice(0, 3));
    if (!codes.includes(code)) {
      throw new Error(`SMTP unexpected response: ${text.trim()}`);
    }
    return text;
  }

  async command(line: string, ...codes: number[]): Promise<string> {
    this.socket.write(line + "\r\n");
    return this.expect(...codes);
  }

  end(): void {
    this.socket.end();
  }

  private readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      const tryResolve = () => {
        const lines = this.buffer.split(/\r?\n/);
        if (lines.length < 2) return false;
        const complete: string[] = [];
        for (const line of lines) {
          if (!line) continue;
          complete.push(line);
          if (/^\d{3} /.test(line)) {
            this.buffer = this.buffer.slice(complete.join("\r\n").length + 2);
            resolve(complete.join("\n"));
            return true;
          }
        }
        return false;
      };

      if (tryResolve()) return;
      const onData = () => {
        if (tryResolve()) cleanup();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("SMTP connection closed"));
      };
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }
}

function connect(config: Required<MailConfig>["smtp"]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect(config.port, config.host, { servername: config.host })
      : net.connect(config.port, config.host);
    if (config.secure) {
      socket.once("secureConnect", () => resolve(socket));
    } else {
      socket.once("connect", () => resolve(socket));
    }
    socket.once("error", reject);
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error("SMTP connection timeout"));
    });
  });
}

export function createMailSender(
  config: MailConfig,
):
  | ((subject: string, body: string, recipients: string[]) => Promise<void>)
  | undefined {
  const smtp = config.smtp;
  if (!smtp?.host || !smtp.port || !smtp.from) return undefined;

  return async (subject, body, recipients) => {
    if (recipients.length === 0) return;
    const socket = await connect(smtp);
    const session = new SmtpSession(socket);
    try {
      await session.expect(220);
      await session.command("EHLO auth2api", 250);
      if (smtp.user && smtp.pass) {
        await session.command("AUTH LOGIN", 334);
        await session.command(base64(smtp.user), 334);
        await session.command(base64(smtp.pass), 235);
      }
      await session.command(`MAIL FROM:<${extractEmail(smtp.from)}>`, 250);
      for (const recipient of recipients) {
        await session.command(`RCPT TO:<${extractEmail(recipient)}>`, 250, 251);
      }
      await session.command("DATA", 354);
      socket.write(buildMessage(smtp.from, recipients, subject, body));
      socket.write("\r\n.\r\n");
      await session.expect(250);
      await session.command("QUIT", 221);
    } finally {
      session.end();
    }
  };
}
