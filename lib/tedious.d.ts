// tedious 16 (the version mssql 10 brings) ships no declarations; they arrive
// in tedious 18. This declares only what lib/db/connection.ts uses.
declare module "tedious" {
  export interface DataType {
    readonly id: number;
    readonly name: string;
  }

  export const TYPES: {
    readonly Bit: DataType;
    readonly DateTime2: DataType;
    readonly Decimal: DataType;
    readonly Int: DataType;
    readonly NVarChar: DataType;
    readonly VarChar: DataType;
  };

  export interface ConnectionConfiguration {
    server: string;
    authentication:
      | { type: "default"; options: { userName: string; password: string } }
      | { type: "azure-active-directory-msi-app-service"; options: { clientId?: string } };
    options: {
      database: string;
      port?: number;
      encrypt: boolean;
      trustServerCertificate: boolean;
      connectTimeout: number;
      requestTimeout: number;
      rowCollectionOnRequestCompletion: boolean;
    };
  }

  export class Connection {
    constructor(config: ConnectionConfiguration);
    connect(callback: (error?: Error) => void): void;
    execSql(request: Request): void;
    close(): void;
  }

  export class Request {
    constructor(sql: string, callback: (error: Error | null | undefined, rowCount?: number, rows?: unknown[]) => void);
    addParameter(name: string, type: DataType, value: unknown): void;
  }
}
