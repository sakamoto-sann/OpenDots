import { createServer } from 'node:http';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export interface CodexTool {
  name: string;
  description?: string;
  parameters: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}
export type ChatImage = { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array };

// This dependency-free MCP client forwards only this turn's scoped tools over
// a private Unix socket. It never receives application or infrastructure keys.
const bridge = `import {createInterface} from 'node:readline';
import {request} from 'node:http';
const socketPath=process.argv[2];
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const call=(method,params)=>new Promise((resolve,reject)=>{
 const req=request({socketPath,path:'/'+method,method:'POST',headers:{'content-type':'application/json'}},res=>{
 let data='',size=0;res.on('data',chunk=>{size+=chunk.length;if(size>8000000){res.destroy();reject(new Error('limit'));}else data+=chunk;});
 res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('denied');resolve(JSON.parse(data));}catch{reject(new Error('failed'));}});res.on('error',reject);
 });req.on('error',reject);req.end(JSON.stringify(params??{}));
});
for await(const line of createInterface({input:process.stdin})){
 let m;try{if(line.length>1000000)throw new Error();m=JSON.parse(line);if(m.id===undefined)continue;
 let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'opendots',version:'1.0.0'}};
 else if(m.method==='ping')result={};
 else if(m.method==='tools/list')result=await call('list',{});
 else if(m.method==='tools/call')result=await call('call',m.params);
 else {send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported method'}});continue;}
 send({jsonrpc:'2.0',id:m.id,result});
 }catch{if(m?.id!==undefined)send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'OpenDots tool request failed'}});}
}`;

export async function codexToolGateway(
  directory: string,
  tools: CodexTool[],
  signal: AbortSignal,
  check: () => void,
  onImage?: (image: ChatImage) => Promise<void>,
) {
  const socket = join(directory, 'tools.sock');
  const script = join(directory, 'tools.mjs');
  await writeFile(script, bridge, { mode: 0o600 });
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: z.toJSONSchema(tool.parameters, { target: 'draft-7' }),
  }));
  let busy = false;
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      signal.throwIfAborted();
      check();
      if (request.method !== 'POST') return reply(403, {});
      if (request.url === '/list') return reply(200, { tools: catalog });
      if (request.url !== '/call' || busy) return reply(403, {});
      busy = true;
      try {
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const raw of request) {
          bytes += raw.length;
          if (bytes > 1000000) throw new Error('Input limit');
          chunks.push(raw);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const tool = tools.find((t) => t.name === input.name);
        if (!tool) throw new Error('Unknown tool');
        const parsed = tool.parameters.parse(input.arguments ?? {});
        check();
        signal.throwIfAborted();
        const result = await tool.execute(parsed);
        check();
        signal.throwIfAborted();
        const content: Array<Record<string, unknown>> = [];
        const image =
          result && typeof result === 'object'
            ? (result as Record<string, unknown>)
            : undefined;
        const base64 = image?.base64;
        if (typeof base64 === 'string' && tool.name === 'computer_screenshot') {
          const bytes = Buffer.from(base64, 'base64');
          if (
            bytes.length > 3000000 ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            throw new Error('Invalid screenshot');
          content.push({ type: 'image', data: base64, mimeType: 'image/png' });
          await onImage?.({ mime: 'image/png', bytes });
          const rest = { ...image };
          delete rest.base64;
          content.push({ type: 'text', text: JSON.stringify(rest) });
        } else {
          const text = JSON.stringify(result ?? null);
          if (text.length > 1000000) throw new Error('Output limit');
          content.push({ type: 'text', text });
        }
        reply(200, { content });
      } catch {
        reply(200, {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'OpenDots could not execute this tool. Check permissions, current revision, service configuration and availability; do not claim success.',
            },
          ],
        });
      } finally {
        busy = false;
      }
    } catch {
      reply(403, {});
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return {
    args: [
      '--config',
      `mcp_servers.opendots.command=${JSON.stringify(process.execPath)}`,
      '--config',
      `mcp_servers.opendots.args=${JSON.stringify([script, socket])}`,
      '--config',
      'mcp_servers.opendots.required=true',
      '--config',
      'mcp_servers.opendots.default_tools_approval_mode="approve"',
    ],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
