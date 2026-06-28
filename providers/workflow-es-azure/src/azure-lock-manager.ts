import { injectable, inject } from "inversify";
import { BlobService, createBlobServiceWithSas, createBlobService, ErrorOrResult, ErrorOrResponse, ServiceResponse } from "azure-storage";
import { IDistributedLockProvider, TYPES, ILogger } from '@reactorynet/workflow-es';

@injectable()
export class AzureLockManager implements IDistributedLockProvider {

    private blobService: BlobService;
    private containerId: string = 'workflowlocks';
    private leaseDuration: number = 60;
    private leases: any = {};
    private renewTimer: any;

    constructor(connectionString: string) {
        var self = this;
        this.blobService = createBlobService(connectionString);
        this.blobService.createContainerIfNotExists(this.containerId, (error: Error, result: BlobService.ContainerResult, response: ServiceResponse): void => {
            if (error) {
                // P4.2: surface the failure instead of swallowing it (was `//TODO: log`). Without the
                // lock container, acquireLock cannot succeed — and we must NOT arm the renew timer for
                // a manager that can never hold a lease (P1.1).
                console.error(`[AzureLockManager] Failed to ensure lock container '${self.containerId}': ${(error && error.message) || error}`);
                return;
            }
            self.renewTimer = setInterval(self.renewLeases, 45000, self);
        });
    }

    public async acquireLock(id: string): Promise<boolean> {
        var self = this;

        // M6: `id` arrives tenant-namespaced (`tenant:resourceId`). ':' is not a
        // safe Azure blob-name character, so sanitise to a blob name. The lease
        // map is keyed by the SAME blob name so release/renew stay consistent.
        const blobName = this.blobName(id);

        if (!await this.createBlob(blobName))
            return false;

        return new Promise<boolean>((resolve, reject) => {
            self.blobService.acquireLease(self.containerId, blobName, { leaseDuration: self.leaseDuration }, (error: Error, result: BlobService.LeaseResult, response: ServiceResponse): void => {
                if (response.isSuccessful) {
                    self.leases[blobName] = result.id;
                }
                resolve(response.isSuccessful);
            });
        });
    }

    public async releaseLock(id: string): Promise<void> {
        var self = this;
        const blobName = this.blobName(id);
        let leaseId = this.leases[blobName];

        if (!leaseId)
            return Promise.resolve();

        self.leases[blobName] = null;

        return new Promise<void>((resolve, reject) => {
            self.blobService.releaseLease(self.containerId, blobName, leaseId, (error: Error, result: BlobService.LeaseResult, response: ServiceResponse): void => {
                resolve();
            });
        });
    }

    /**
     * M6: sanitise a (possibly tenant-namespaced) lock key into a legal Azure
     * blob name. ':' is replaced with '-' consistently across create/acquire/
     * release/renew so the same key always maps to the same blob.
     */
    private blobName(id: string): string {
        return id.replace(/:/g, "-");
    }

    private createBlob(blobName: string): Promise<boolean> {
        var self = this;
        return new Promise<boolean>((resolve, reject) => {
            self.blobService.createBlockBlobFromText(self.containerId, blobName, '', (error: Error, result: BlobService.BlobResult, response: ServiceResponse): void => {
                resolve(response.isSuccessful);
            });
        });
    }

    private renewLeases(self: AzureLockManager) {
        // `leases` is already keyed by the sanitised blob name.
        for (let blobName in self.leases) {
            if (self.leases[blobName]) {
                self.blobService.renewLease(self.containerId, blobName, self.leases[blobName], (error: Error, result: BlobService.LeaseResult, response: ServiceResponse): void => {
                    // P1.4: on renew failure the lease is lost — drop the entry so the blob can be
                    // re-acquired by another holder (mirrors the Redis lock manager's catch-delete).
                    // Leaving a stale entry would let this node believe it still owns a lease another
                    // node can now take.
                    if (error || !response || !response.isSuccessful) {
                        console.warn(`[AzureLockManager] Lease renewal failed for '${blobName}'; dropping the lease so it can be re-acquired.`);
                        delete self.leases[blobName];
                    }
                });
            }
        }
    }

}