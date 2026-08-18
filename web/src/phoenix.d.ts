declare module 'phoenix' {
  export class Socket {
    constructor(endPoint: string, opts?: any);
    connect(): void;
    disconnect(): void;
    channel(topic: string, chanParams?: any): Channel;
    onError(callback: (error: any) => void): void;
    onOpen(callback: () => void): void;
    onClose(callback: () => void): void;
  }
  export class Channel {
    join(): Push;
    on(event: string, callback: (msg: any) => void): void;
    push(event: string, payload: any, timeout?: number): Push;
  }
  export class Push {
    receive(status: string, callback: (reply: any) => void): Push;
  }
}
