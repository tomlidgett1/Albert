import { z } from "zod";
import { roleSchema } from "../../../packages/semantic-registry/src/index.js";
import { correlationIdFromHeader,createServiceLogger,safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import {
  semanticToolInputSchemas,
  semanticToolResponseSchema,
} from "../../../packages/agent/src/semantic-tools.js";
import {
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  verifyInternalRequest,
} from "../../../packages/security/src/index.js";
import { SEMANTIC_TOOL_NAMES,type SemanticToolExecutor,type SemanticToolName } from "./types.js";

const logger=createServiceLogger("semantic-query");

const bodySchema=z.object({tenantId:z.string().min(1),role:roleSchema,conversationId:z.string().min(1),turnId:z.string().min(1),confirmedValue:z.string().max(300).optional(),input:z.unknown()}).strict();

export type SemanticHttpHandlerOptions=Readonly<{
  hmacSecret:string;
  clock?:()=>number;
  maxClockSkewMs?:number;
}>;

export function createSemanticHttpHandler(executor:SemanticToolExecutor,options:SemanticHttpHandlerOptions):(request:Request)=>Promise<Response>{
  const clock=options.clock??Date.now;
  const maxSkew=options.maxClockSkewMs??60_000;
  return async(request:Request):Promise<Response>=>{
    const correlationId=correlationIdFromHeader(request.headers.get("x-request-id"));
    if(request.method!=="POST")return json({error:{code:"METHOD_NOT_ALLOWED",message:"Use POST."}},405,correlationId);
    const url=new URL(request.url);
    const match=/^\/v1\/tools\/([a-z_]+)$/.exec(url.pathname);
    if(!match||!SEMANTIC_TOOL_NAMES.includes(match[1] as SemanticToolName))return json({error:{code:"NOT_FOUND",message:"Unknown semantic tool endpoint."}},404,correlationId);
    const toolName=match[1] as SemanticToolName;
    const timestamp=request.headers.get(INTERNAL_TIMESTAMP_HEADER);
    const signature=request.headers.get(INTERNAL_SIGNATURE_HEADER);
    if(!timestamp||!signature)return json({error:{code:"UNAUTHENTICATED",message:"Signed internal transport headers are required."}},401,correlationId);
    const rawBody=await request.text();
    const verified=await verifyInternalRequest({method:request.method,path:url.pathname,body:rawBody,secret:options.hmacSecret,timestamp,signature,now:clock(),maxSkewMs:maxSkew});
    if(!verified)return json({error:{code:"INVALID_SIGNATURE",message:"Internal transport signature is invalid or stale."}},401,correlationId);
    try{
      const body=bodySchema.parse(JSON.parse(rawBody));
      const input=semanticToolInputSchemas[toolName].parse(body.input);
      const response=await executor.execute(toolName,input,{tenantId:body.tenantId,role:body.role,conversationId:body.conversationId,turnId:body.turnId,...(body.confirmedValue===undefined?{}:{confirmedValue:body.confirmedValue})});
      return json(semanticToolResponseSchema.parse(response),200,correlationId);
    }catch(error){
      if(error instanceof SemanticCompilerError)return json({error:error.toJSON()},compilerStatus(error),correlationId);
      if(error instanceof z.ZodError)return json({error:{code:"INVALID_REQUEST",message:"Request body or tool input is invalid.",details:error.issues}},400,correlationId);
      logger.error("tool_request_failed",{tool:toolName,...safeErrorEvidence(error)},correlationId);
      return json({error:{code:"SEMANTIC_TOOL_ERROR",message:"The governed query service could not complete this request."}},503,correlationId);
    }
  };
}

export async function signSemanticHttpRequest(path:string,rawBody:string,secret:string,timestamp?:number):Promise<Readonly<Record<string,string>>>{
  return signInternalRequest({method:"POST",path,body:rawBody,secret,...(timestamp===undefined?{}:{timestamp})});
}
function json(value:unknown,status:number,correlationId?:string):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...(correlationId?{"x-request-id":correlationId}:{})}});}
function compilerStatus(error:SemanticCompilerError):number{return error.code==="FORBIDDEN_ROLE"?403:error.code==="MISSING_CAPABILITY"?422:400;}
