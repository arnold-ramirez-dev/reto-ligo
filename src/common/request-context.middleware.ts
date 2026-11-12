import { Injectable, Logger, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
    rawBody?: Buffer;
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = req.header("x-request-id") ?? randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const startedAt = performance.now();
    res.on("finish", () => {
      this.logger.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    });
    next();
  }
}
