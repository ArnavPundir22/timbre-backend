declare module 'phoenix' {
  export class Socket {
    constructor(endPoint: string, opts?: any);
    connect(): void;
    channel(topic: string, chanParams?: any): Channel;
  }
  export class Channel {
    join(): Push;
    on(event: string, callback: (msg: any) => void): void;
    push(event: string, payload: any): Push;
  }
  export class Push {
    receive(status: string, callback: (reply: any) => void): Push;
  }
}
