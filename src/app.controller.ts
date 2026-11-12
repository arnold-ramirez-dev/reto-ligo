import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

@Controller()
@ApiTags("System")
export class AppController {
  @Get("health")
  @ApiOperation({ summary: "Health check del servicio" })
  @ApiOkResponse({ schema: { example: { status: "ok" } } })
  health(): { status: string } {
    return { status: "ok" };
  }
}
