import * as pb from "../proto/orchestrator_service_pb";
import * as stubs from "../proto/orchestrator_service_grpc_pb";
import * as grpc from "@grpc/grpc-js";
import { Registry } from "./registry";
import { TActivity } from "../types/activity.type";
import { TInput } from "../types/input.type";
import { TOrchestrator } from "../types/orchestrator.type";
import { TOutput } from "../types/output.type";
import { GrpcClient } from "../client-grpc";
import { promisify } from "util";
import { Empty } from "google-protobuf/google/protobuf/empty_pb";
import * as pbh from "../utils/pb-helper.util";
import { OrchestrationExecutor } from "./orchestration-executor";
import { ActivityExecutor } from "./activity-executor";
import { StringValue } from "google-protobuf/google/protobuf/wrappers_pb";

export class TaskHubGrpcWorker {
  private _responseStream: grpc.ClientReadableStream<pb.WorkItem> | null;
  private _registry: Registry;
  private _hostAddress: string;
  private _isRunning: boolean;

  constructor(hostAddress?: string) {
    this._registry = new Registry();
    this._hostAddress = hostAddress ?? "localhost:50001"; // @todo: get default host address
    this._responseStream = null;
    this._isRunning = false;
  }

  /**
   * Registers an orchestrator function with the worker.
   *
   * @param fn
   * @returns
   */
  addOrchestrator(fn: TOrchestrator): string {
    if (this._isRunning) {
      throw new Error("Cannot add orchestrator while worker is running.");
    }

    return this._registry.addOrchestrator(fn);
  }

  /**
   * Registers an activity function with the worker.
   *
   * @param fn
   * @returns
   */
  addActivity(fn: TActivity<TInput, TOutput>): string {
    if (this._isRunning) {
      throw new Error("Cannot add activity while worker is running.");
    }

    return this._registry.addActivity(fn);
  }

  /**
   * In node.js we don't require a new thread as we have a main event loop
   * Therefore, we open the stream and simply listen through the eventemitter behind the scenes
   */
  async start(): Promise<void> {
    const stub = new GrpcClient(this._hostAddress).stub;

    if (this._isRunning) {
      throw new Error("The worker is already running.");
    }

    const stubHello = promisify(stub.hello);
    console.log(stubHello);
    await stubHello(new Empty());

    // Open a stream to get the work items
    const stubGetWorkItemsReq = new pb.GetWorkItemsRequest();
    stub.getWorkItems(stubGetWorkItemsReq);
    this._responseStream = stub.getWorkItems(stubGetWorkItemsReq);

    console.log(`Successfully connected to ${this._hostAddress}. Waiting for work items...`);

    // Wait for a work item to be received
    this._responseStream.on("data", (workItem: pb.WorkItem) => {
      if (workItem.hasOrchestratorrequest()) {
        console.log(`Received "Orchestrator Request" work item`);
        this._executeOrchestrator(workItem.getOrchestratorrequest() as any, stub);
      } else if (workItem.hasActivityrequest()) {
        console.log(`Received "Activity Request" work item`);
        this._executeActivity(workItem.getActivityrequest() as any, stub);
      } else {
        console.log(`Received unknown work item`);
      }
    });

    // Wait for the stream to end or error
    this._responseStream.on("end", () => {
      console.log("Stream ended");
    });

    this._responseStream.on("error", (err: Error) => {
      console.log("Stream error", err);
    });

    this._isRunning = true;
  }

  /**
   * Stop the worker and wait for any pending work items to complete
   */
  async stop(): Promise<void> {
    if (!this._isRunning) {
      throw new Error("The worker is not running.");
    }

    if (this._responseStream) {
      this._responseStream.destroy();
    }

    this._isRunning = false;
  }

  /**
   *
   */
  private async _executeOrchestrator(
    req: pb.OrchestratorRequest,
    stub: stubs.TaskHubSidecarServiceClient,
  ): Promise<void> {
    let res;

    try {
      const executor = new OrchestrationExecutor(this._registry);
      const actions = await executor.execute(req.getInstanceid(), req.getPasteventsList(), req.getNeweventsList());

      res = new pb.OrchestratorResponse();
      res.setInstanceid(req.getInstanceid());
      res.setActionsList(actions);
    } catch (e: any) {
      console.error(e);
      console.log(`An error occurred while trying to execute instance '${req.getInstanceid()}': ${e.message}`);

      const failureDetails = pbh.newFailureDetails(e);

      const actions = [
        pbh.newCompleteOrchestrationAction(
          -1,
          pb.OrchestrationStatus.ORCHESTRATION_STATUS_FAILED,
          failureDetails?.toString(),
        ),
      ];

      res = new pb.OrchestratorResponse();
      res.setInstanceid(req.getInstanceid());
      res.setActionsList(actions);
    }

    try {
      const stubCompleteOrchestratorTask = promisify(stub.completeOrchestratorTask);
      await stubCompleteOrchestratorTask(res);
    } catch (e: any) {
      console.error(`An error occurred while trying to complete instance '${req.getInstanceid()}': ${e?.message}`);
    }
  }

  /**
   *
   */
  private async _executeActivity(req: pb.ActivityRequest, stub: stubs.TaskHubSidecarServiceClient): Promise<void> {
    const instanceId = req.getOrchestrationinstance()?.getInstanceid();

    if (!instanceId) {
      throw new Error("Activity request does not contain an orchestration instance id");
    }

    let res;

    try {
      const executor = new ActivityExecutor(this._registry);
      const result = await executor.execute(req.getName(), req.getInput()?.toString() ?? "", req.getTaskid());

      const s = new StringValue();
      s.setValue(result ?? "");

      res = new pb.ActivityResponse();
      res.setInstanceid(instanceId);
      res.setTaskid(req.getTaskid());
      res.setResult(s);
    } catch (e: any) {
      console.error(e);
      console.log(`An error occurred while trying to execute activity '${req.getName()}': ${e.message}`);

      const failureDetails = pbh.newFailureDetails(e);

      res = new pb.ActivityResponse();
      res.setTaskid(req.getTaskid());
      res.setFailuredetails(failureDetails);
    }

    try {
      const stubCompleteActivityTask = promisify(stub.completeActivityTask);
      await stubCompleteActivityTask(res);
    } catch (e: any) {
      console.error(
        `Failed to deliver activity response for '${req.getName()}#${req.getTaskid()}' of orchestration ID '${instanceId}' to sidecar: ${
          e?.message
        }`,
      );
    }
  }
}
