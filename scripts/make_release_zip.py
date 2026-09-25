# 最终发布 zip: Python zipfile, UTF-8 标志正确 (mac/英文系统解压不乱码), store 压缩
import os, sys, zipfile, time

SRC = r'C:\Users\krkld\.openclaw\projects\english-study\build\dist\英语背诵工具'
OUT = r'C:\Users\krkld\.openclaw\projects\english-study\build\英语背诵工具-一体化版.zip'
EXCLUDE_TOP = {'tmp'}  # 运行时缓存不进包

t0 = time.time()
n = 0
EXEC_SUFFIX = ('.command', 'EnglishStudyApp')
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_STORED, allowZip64=True, strict_timestamps=False) as zf:
    def w(fp, arc):
        zi = zipfile.ZipInfo(arc, date_time=time.localtime(os.path.getmtime(fp))[:6])
        if arc.endswith(EXEC_SUFFIX) or arc.endswith('/'):
            zi.external_attr = 0o755 << 16
        else:
            zi.external_attr = 0o644 << 16
        zi.compress_type = zipfile.ZIP_STORED
        with open(fp, 'rb') as fh:
            zf.writestr(zi, fh.read())
    for root, dirs, files in os.walk(SRC):
        rel_root = os.path.relpath(root, os.path.dirname(SRC))  # 英语背诵工具/...
        parts = rel_root.split(os.sep)
        if len(parts) > 1 and parts[1] in EXCLUDE_TOP:
            dirs[:] = []
            continue
        for f in files:
            fp = os.path.join(root, f)
            arc = os.path.join(rel_root, f)
            try:
                w(fp, arc)
                n += 1
                if n % 2000 == 0:
                    print(f'{n} files, {os.path.getsize(OUT)/1048576:.0f} MB, {time.time()-t0:.0f}s', flush=True)
            except Exception as e:
                print('SKIP', arc, repr(e)[:80], flush=True)
print(f'DONE {n} files {os.path.getsize(OUT)/1073741824:.2f} GB in {time.time()-t0:.0f}s')
