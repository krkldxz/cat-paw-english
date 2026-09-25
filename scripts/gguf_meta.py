import struct, sys
sys.stdout.reconfigure(encoding='utf-8')

def gguf_meta(path, want=('general.name', 'general.architecture', 'mmproj.projector_type', 'general.description', 'gemmascope.vocab_size', 'tokenizer.ggml.model', 'hparams.n_layer')):
    f = open(path, 'rb')
    assert f.read(4) == b'GGUF'
    ver = struct.unpack('<I', f.read(4))[0]
    ntensor = struct.unpack('<Q', f.read(8))[0]
    nkv = struct.unpack('<Q', f.read(8))[0]
    TN = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'bool', 'string', 'array', 'uint64', 'int64', 'float64']
    FMT = {'uint8': '<B', 'int8': '<b', 'uint16': '<H', 'int16': '<h', 'uint32': '<I', 'int32': '<i', 'float32': '<f', 'uint64': '<Q', 'int64': '<q', 'float64': '<d'}
    SZ = {k: struct.calcsize(v) for k, v in FMT.items()}; SZ['bool'] = 1

    def rd_s():
        n = struct.unpack('<Q', f.read(8))[0]
        return f.read(n).decode('utf-8', 'replace')

    def rd_one(ty):
        if ty == 'string':
            return rd_s()
        if ty == 'bool':
            return f.read(1)[0]
        return struct.unpack(FMT[ty], f.read(SZ[ty]))[0]

    out = {}
    for _ in range(nkv):
        k = rd_s()
        t = struct.unpack('<I', f.read(4))[0]
        ty = TN[t] if t < len(TN) else str(t)
        if ty == 'array':
            at = struct.unpack('<I', f.read(4))[0]
            an = struct.unpack('<Q', f.read(8))[0]
            aty = TN[at]
            v = [rd_one(aty) for _ in range(min(an, 6))]
            if an > 6:
                v.append('...')
        else:
            v = rd_one(ty)
        if any(w in k for w in want):
            out[k] = str(v)[:400]
    return out

base = r'C:\Users\krkld\.openclaw\projects\english-study\models'
for m in ['gemma-4-E2B-it-Q4_K_M.gguf', 'gemma-4-E2B-mmproj-F16.gguf']:
    print('=====', m)
    try:
        for k, v in gguf_meta(base + '\\' + m).items():
            print(' ', k, '=', v[:300])
    except Exception as e:
        print(' ERR', repr(e)[:120])
