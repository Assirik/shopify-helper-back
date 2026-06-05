import { IUser } from "../../src/models/User";
import { IDevice } from "../../src/models/Device";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: IUser;
      device?: IDevice; // Add the device property to the Request interface
    }
  }
}
