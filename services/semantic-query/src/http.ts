import { z } from "zod";
import { roleSchema } from "../../../packages/semantic-registry/src/index.js";
import {
  answerArtifactFinalizationInputSchema,
  answerArtifactFinalizationV2InputSchema,
  answerArtifactFinalizationResultSchema,
  modelUsageCheckpointInputSchema,
  modelUsageCheckpointResultSchema,
  semanticV2AnswerArtifactFinalizationInputSchema,
} from "../../../packages/shared/src/index.js";
import { correlationIdFromHeader,createServiceLogger,safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import { SemanticCompilerV2Error } from "../../../packages/compiler/src/v2.js";
import { SEMANTIC_V2_TOOL_NAMES,type SemanticV2ToolName } from "../../../packages/agent/src/semantic-v2-tools.js";
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
import type { AnswerArtifactFinalizer } from "./answer-artifact-finalizer.js";
import type { ModelUsageRecorder } from "./model-usage-recorder.js";
import { SemanticV2ServiceError,type SemanticV2ToolExecutor } from "./v2-service.js";

const logger=createServiceLogger("semantic-query");

const bodySchema=z.object({tenantId:z.string().min(1),role:roleSchema,conversationId:z.string().min(1),turnId:z.string().min(1),confirmedPreference:z.string().max(120).optional(),confirmedValue:z.string().max(300).optional(),input:z.unknown()}).strict();

export type SemanticHttpHandlerOptions=Readonly<{
  hmacSecret:string;
  answerArtifactFinalizer?:AnswerArtifactFinalizer;
  modelUsageRecorder?:ModelUsageRecorder;
  v2Executor?:SemanticV2ToolExecutor;
  analyticalRuntime?:"v1"|"v2";
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
    const v2Match=/^\/v2\/tools\/([a-z_]+)$/.exec(url.pathname);
    const finalizationRequest=url.pathname==="/v1/answer-artifacts/finalize";
    const finalizationV2Request=url.pathname==="/v2/answer-artifacts/finalize";
    const semanticFinalizationV2Request=url.pathname==="/v2/analytical-answer-artifacts/finalize";
    const usageCheckpointRequest=url.pathname==="/v1/model-usage/checkpoint";
    const validV2Tool=Boolean(v2Match&&SEMANTIC_V2_TOOL_NAMES.includes(v2Match[1] as SemanticV2ToolName));
    if((!match||!SEMANTIC_TOOL_NAMES.includes(match[1] as SemanticToolName))&&!validV2Tool&&!finalizationRequest&&!finalizationV2Request&&!semanticFinalizationV2Request&&!usageCheckpointRequest)return json({error:{code:"NOT_FOUND",message:"Unknown semantic endpoint."}},404,correlationId);
    const toolName=match?.[1] as SemanticToolName|undefined;
    const v2ToolName=v2Match?.[1] as SemanticV2ToolName|undefined;
    const timestamp=request.headers.get(INTERNAL_TIMESTAMP_HEADER);
    const signature=request.headers.get(INTERNAL_SIGNATURE_HEADER);
    if(!timestamp||!signature)return json({error:{code:"UNAUTHENTICATED",message:"Signed internal transport headers are required."}},401,correlationId);
    const rawBody=await request.text();
    const verified=await verifyInternalRequest({method:request.method,path:url.pathname,body:rawBody,secret:options.hmacSecret,timestamp,signature,now:clock(),maxSkewMs:maxSkew});
    if(!verified)return json({error:{code:"INVALID_SIGNATURE",message:"Internal transport signature is invalid or stale."}},401,correlationId);
    try{
      if(finalizationRequest){
        if(!options.answerArtifactFinalizer)return json({error:{code:"FINALIZER_UNAVAILABLE",message:"Answer artefact finalization is unavailable."}},503,correlationId);
        const input=answerArtifactFinalizationInputSchema.parse(JSON.parse(rawBody));
        const result=await options.answerArtifactFinalizer.finalize(input);
        return json({result:answerArtifactFinalizationResultSchema.parse(result)},200,correlationId);
      }
      if(finalizationV2Request){
        if(!options.answerArtifactFinalizer)return json({error:{code:"FINALIZER_UNAVAILABLE",message:"Answer artefact finalization is unavailable."}},503,correlationId);
        const {provider:_provider,...input}=answerArtifactFinalizationV2InputSchema.parse(JSON.parse(rawBody));
        void _provider;
        const result=await options.answerArtifactFinalizer.finalize(input);
        return json({result:answerArtifactFinalizationResultSchema.parse(result)},200,correlationId);
      }
      if(semanticFinalizationV2Request){
        if(options.analyticalRuntime!=="v2")return json({error:{code:"V2_ROUTE_DISABLED",message:"The V2 analytical route is disabled for this service instance."}},409,correlationId);
        if(!options.answerArtifactFinalizer)return json({error:{code:"FINALIZER_UNAVAILABLE",message:"Semantic V2 answer artefact finalization is unavailable."}},503,correlationId);
        const input=semanticV2AnswerArtifactFinalizationInputSchema.parse(JSON.parse(rawBody));
        const result=await options.answerArtifactFinalizer.finalizeSemanticV2(input);
        return json({result:answerArtifactFinalizationResultSchema.parse(result)},200,correlationId);
      }
      if(usageCheckpointRequest){
        if(!options.modelUsageRecorder)return json({error:{code:"USAGE_RECORDER_UNAVAILABLE",message:"Model usage recording is unavailable."}},503,correlationId);
        const input=modelUsageCheckpointInputSchema.parse(JSON.parse(rawBody));
        const result=await options.modelUsageRecorder.record(input);
        return json({result:modelUsageCheckpointResultSchema.parse(result)},200,correlationId);
      }
      if(v2ToolName){
        if(options.analyticalRuntime!=="v2")return json({error:{code:"V2_ROUTE_DISABLED",message:"The V2 analytical route is disabled for this service instance."}},409,correlationId);
        if(!options.v2Executor)return json({error:{code:"V2_EXECUTOR_UNAVAILABLE",message:"The V2 semantic executor is unavailable."}},503,correlationId);
        const body=bodySchema.parse(JSON.parse(rawBody));
        const result=await options.v2Executor.execute(v2ToolName,body.input,{tenantId:body.tenantId,role:body.role,conversationId:body.conversationId,turnId:body.turnId,...(body.confirmedPreference===undefined?{}:{confirmedPreference:body.confirmedPreference}),...(body.confirmedValue===undefined?{}:{confirmedValue:body.confirmedValue})});
        return json({result},200,correlationId);
      }
      if(!toolName)throw new Error("Semantic tool routing invariant failed.");
      const body=bodySchema.parse(JSON.parse(rawBody));
      const input=semanticToolInputSchemas[toolName].parse(body.input);
      const response=await executor.execute(toolName,input,{tenantId:body.tenantId,role:body.role,conversationId:body.conversationId,turnId:body.turnId,...(body.confirmedPreference===undefined?{}:{confirmedPreference:body.confirmedPreference}),...(body.confirmedValue===undefined?{}:{confirmedValue:body.confirmedValue})});
      return json(semanticToolResponseSchema.parse(response),200,correlationId);
    }catch(error){
      if(error instanceof SemanticCompilerError)return json({error:error.toJSON()},compilerStatus(error),correlationId);
      if(error instanceof SemanticCompilerV2Error)return json({error:{code:error.code,message:error.message,details:error.details}},422,correlationId);
      if(error instanceof SemanticV2ServiceError)return json({error:{code:error.code,message:error.message,details:error.details}},error.status,correlationId);
      if(error instanceof z.ZodError)return json({error:{code:"INVALID_REQUEST",message:"Request body or tool input is invalid.",details:error.issues}},400,correlationId);
      logger.error(finalizationRequest||finalizationV2Request||semanticFinalizationV2Request?"answer_artifact_finalization_failed":usageCheckpointRequest?"model_usage_checkpoint_failed":"tool_request_failed",{...(toolName?{tool:toolName}:{}),...safeErrorEvidence(error),...(process.env.ALBERT_DEBUG_ERRORS==='1'?{debugMessage:error instanceof Error?error.message.slice(0,300):String(error).slice(0,300),debugStack:error instanceof Error?(error.stack??'').split('\n').slice(0,5).join(' | '):''}:{})},correlationId);
      return json({error:{code:"SEMANTIC_TOOL_ERROR",message:"The governed query service could not complete this request."}},503,correlationId);
    }
  };
}

export async function signSemanticHttpRequest(path:string,rawBody:string,secret:string,timestamp?:number):Promise<Readonly<Record<string,string>>>{
  return signInternalRequest({method:"POST",path,body:rawBody,secret,...(timestamp===undefined?{}:{timestamp})});
}
function json(value:unknown,status:number,correlationId?:string):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...(correlationId?{"x-request-id":correlationId}:{})}});}
function compilerStatus(error:SemanticCompilerError):number{return error.code==="FORBIDDEN_ROLE"?403:error.code==="MISSING_CAPABILITY"?422:400;}
