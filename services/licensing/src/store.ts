export interface LicenseTransaction { get<T>(path: string): Promise<T | null>; find<T>(collection: string, field: string, value: string): Promise<T[]>; set<T extends object>(path: string, value: T): void; }
export interface LicenseStore { transaction<T>(operation: (tx: LicenseTransaction) => Promise<T>, options?: { readOnly: boolean }): Promise<T>; }
