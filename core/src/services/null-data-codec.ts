import { injectable } from "inversify";
import { IDataCodec, DataCodecContext } from "../abstractions";

/**
 * H6 — the no-op default codec. With this bound (the default), the at-rest bytes are
 * byte-identical to the pre-H6 engine and there is zero behaviour change / no migration.
 * A real encrypting/redacting codec is supplied by the consumer via config.useDataCodec(...).
 */
@injectable()
export class NullDataCodec implements IDataCodec {
    public async encode(value: any, _context: DataCodecContext): Promise<any> {
        return value;
    }
    public async decode(value: any, _context: DataCodecContext): Promise<any> {
        return value;
    }
}
