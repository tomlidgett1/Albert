import { createServer,type IncomingMessage,type ServerResponse } from "node:http";
import type { AddressInfo,Socket } from "node:net";
import { correlationIdFromHeader,createServiceLogger,safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { createSemanticHttpHandler } from "./http.js";
import type { SemanticServiceComposition } from "./composition.js";

const logger=createServiceLogger("semantic-query");

export type RunningSemanticNodeServer=Readonly<{
  url:string;
  close:()=>Promise<void>;
}>;

export async function startSemanticNodeServer(options:Readonly<{
  composition:SemanticServiceComposition;
  signingSecret:string;
  host?:string;
  port?:number;
  maxBodyBytes?:number;
  shutdownGraceMs?:number;
  releaseSha?:string|null;
  deploymentId?:string|null;
}>):Promise<RunningSemanticNodeServer>{
  if(new TextEncoder().encode(options.signingSecret).byteLength<32)throw new Error("ALBERT_SEMANTIC_SIGNING_SECRET must be at least 32 bytes.");
  const host=options.host??"127.0.0.1";const port=options.port??8788;const maxBodyBytes=options.maxBodyBytes??1_048_576;
  const toolHandler=createSemanticHttpHandler(options.composition.executor,{
    hmacSecret:options.signingSecret,
    answerArtifactFinalizer:options.composition.answerArtifactFinalizer,
    modelUsageRecorder:options.composition.modelUsageRecorder,
    v2Executor:options.composition.v2Executor,
    analyticalRuntime:options.composition.analyticalRuntime??"v1",
  });
  const sockets=new Set<Socket>();let closing=false;
  const server=createServer({maxHeaderSize:16*1024},async(request,response)=>{
    const correlationId=correlationIdFromHeader(typeof request.headers["x-request-id"]==="string"?request.headers["x-request-id"]:undefined);
    try{
      if(request.method==="GET"&&request.url==="/healthz")return sendJson(response,closing?503:200,{status:closing?"stopping":"ok"},correlationId);
      if(request.method==="GET"&&request.url==="/readyz"){
        const readiness=await options.composition.readiness();
        return sendJson(response,!closing&&readiness.ready?200:503,{
          status:!closing&&readiness.ready?"ready":"not_ready",
          runtime:"semantic-query",
          analyticalRuntime:options.composition.analyticalRuntime??"v1",
          v2PublicationHash:options.composition.v2PublicationHash??null,
          releaseSha:options.releaseSha??null,
          deploymentId:options.deploymentId??null,
          checks:readiness.checks,
        },correlationId);
      }
      if(closing)return sendJson(response,503,{error:{code:"SHUTTING_DOWN",message:"Semantic service is stopping."}},correlationId);
      const body=await readBody(request,maxBodyBytes);
      const origin=`http://${request.headers.host??`${host}:${port}`}`;
      const headers=new Headers();for(const [name,value] of Object.entries(request.headers)){if(Array.isArray(value))value.forEach((item)=>headers.append(name,item));else if(value!==undefined)headers.set(name,value);}
      const webRequest=new Request(new URL(request.url??"/",origin),{method:request.method??"GET",headers,...((request.method??"GET")==="GET"||request.method==="HEAD"?{}:{body})});
      const webResponse=await toolHandler(webRequest);response.statusCode=webResponse.status;webResponse.headers.forEach((value,name)=>response.setHeader(name,value));response.end(Buffer.from(await webResponse.arrayBuffer()));
    }catch(error){
      const bodyLimit=error instanceof BodyLimitError;const status=bodyLimit?413:500;
      logger.error("http_request_failed",safeErrorEvidence(error),correlationId);
      sendJson(response,status,{error:{code:bodyLimit?"BODY_TOO_LARGE":"INTERNAL_ERROR",message:bodyLimit?error.message:"Semantic service request failed."}},correlationId);
    }
  });
  server.headersTimeout=10_000;
  server.requestTimeout=45_000;
  server.keepAliveTimeout=5_000;
  server.maxRequestsPerSocket=1_000;
  server.maxHeadersCount=100;
  server.on("connection",(socket)=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolve();});});
  const address=server.address() as AddressInfo;const url=`http://${address.address.includes(":")?`[${address.address}]`:address.address}:${address.port}`;
  return{url,async close(){
    if(closing)return;closing=true;
    const closed=new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
    const timeout=setTimeout(()=>{for(const socket of sockets)socket.destroy();},options.shutdownGraceMs??10_000);timeout.unref();
    try{await closed;}finally{clearTimeout(timeout);await options.composition.close();}
  }};
}

async function readBody(request:IncomingMessage,maxBytes:number):Promise<string>{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buffer.byteLength;if(size>maxBytes)throw new BodyLimitError(`Request body exceeds ${maxBytes} bytes.`);chunks.push(buffer);}
  return Buffer.concat(chunks).toString("utf8");
}
function sendJson(response:ServerResponse,status:number,value:unknown,correlationId?:string):void{if(response.headersSent)return;response.statusCode=status;response.setHeader("content-type","application/json; charset=utf-8");response.setHeader("cache-control","no-store");response.setHeader("x-content-type-options","nosniff");if(correlationId)response.setHeader("x-request-id",correlationId);response.end(JSON.stringify(value));}
class BodyLimitError extends Error{}
