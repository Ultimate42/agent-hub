#!/usr/bin/env python3
"""Client de l'atelier ComfyUI du PC GPU, pour les agents du poste client (bibliothèque standard seulement, aucun secret).

L'atelier n'écoute que sur 127.0.0.1 et sur l'adresse Tailscale du PC GPU, et son pare-feu n'accepte que le poste client :
ce script ne marche que depuis le poste client (ou le PC GPU lui-même). Voir reuse-worker/GPU.md, « Atelier ComfyUI ».

    set COMFY_ATELIER=http://100.x.y.z:8188          (ou --url)
    python comfy-atelier.py status
    python comfy-atelier.py run graphe_api.json --image 12=photo.png --set 6.text="a red mug" --set 3.seed=42 --out sorties
    python comfy-atelier.py models loras
    python comfy-atelier.py nodes KSampler
    python comfy-atelier.py free | interrupt

run : le graphe est au format API (ComfyUI : « Export (API) »). --image NODE=fichier envoie le fichier (/upload/image) et
pose son nom dans inputs.image du nœud NODE (LoadImage). --set NODE.entrée=valeur (valeur JSON si possible, sinon texte).
Attend la fin (/history), télécharge les images et autres fichiers produits (/view) et écrit un résumé JSON sur la sortie.
Code de sortie : 0 réussi, 1 refusé ou raté, 2 délai dépassé.
"""
import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # jamais par un proxy : Tailscale direct


def call(base, method, path, body=None, data=None, headers=None, timeout=60):
    """-> (statut, réponse JSON ou octets)."""
    if body is not None:
        data, headers = json.dumps(body).encode(), dict(headers or {}, **{'Content-Type': 'application/json'})
    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method, headers=headers or {})
    try:
        with OPENER.open(req, timeout=timeout) as r:
            raw, status, ctype = r.read(), r.status, r.headers.get('Content-Type', '')
    except urllib.error.HTTPError as e:
        raw, status, ctype = e.read(), e.code, e.headers.get('Content-Type', '')
    if 'json' in ctype:
        try:
            return status, json.loads(raw or b'null')
        except ValueError:
            pass
    return status, raw


def upload(base, path, subfolder='agents'):
    """POST /upload/image (multipart) -> nom à mettre dans inputs.image d'un LoadImage."""
    path = Path(path)
    edge = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    parts = [('--%s\r\nContent-Disposition: form-data; name="image"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
              % (edge, path.name, ctype)).encode() + path.read_bytes() + b'\r\n']
    for k, v in (('subfolder', subfolder), ('type', 'input'), ('overwrite', 'true')):
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (edge, k, v)).encode())
    status, answer = call(base, 'POST', '/upload/image', data=b''.join(parts) + ('--%s--\r\n' % edge).encode(),
                          headers={'Content-Type': 'multipart/form-data; boundary=%s' % edge}, timeout=300)
    if status != 200 or not isinstance(answer, dict):
        raise SystemExit('envoi de %s refusé (HTTP %s) : %s' % (path, status, answer))
    return '%s/%s' % (answer['subfolder'], answer['name']) if answer.get('subfolder') else answer['name']


def value(text):
    try:
        return json.loads(text)
    except ValueError:
        return text


def run(base, args):
    wf = json.loads(Path(args.workflow).read_text(encoding='utf-8'))
    if 'nodes' in wf and 'links' in wf:
        raise SystemExit('graphe au format interface : l\'exporter au format API (menu Workflow > Export (API))')
    for item in args.image or []:
        node, _, file = item.partition('=')
        wf[node]['inputs']['image'] = upload(base, file)
    for item in args.set or []:
        key, _, v = item.partition('=')
        node, _, field = key.partition('.')
        wf[node]['inputs'][field] = value(v)
    client = 'agent-' + uuid.uuid4().hex[:8]
    status, answer = call(base, 'POST', '/prompt', {'prompt': wf, 'client_id': client})
    if status != 200 or not isinstance(answer, dict) or 'prompt_id' not in answer:
        print(json.dumps({'ok': False, 'http': status, 'error': answer}, ensure_ascii=False, indent=1))
        return 1
    pid, t0 = answer['prompt_id'], time.time()
    while True:
        status, hist = call(base, 'GET', '/history/%s' % pid)
        entry = hist.get(pid) if isinstance(hist, dict) else None
        if entry and (entry.get('status') or {}).get('completed') is not None and entry.get('outputs') is not None:
            if (entry.get('status') or {}).get('status_str') in ('success', 'error'):
                break
        if time.time() - t0 > args.timeout:
            print(json.dumps({'ok': False, 'prompt_id': pid, 'error': 'délai dépassé (%d s) : le calcul continue sur le PC GPU' % args.timeout}))
            return 2
        time.sleep(1)
    st = entry.get('status') or {}
    out = {'ok': st.get('status_str') == 'success', 'prompt_id': pid, 'seconds': round(time.time() - t0, 1), 'files': []}
    if not out['ok']:
        out['error'] = [m for m in st.get('messages') or [] if m and m[0] == 'execution_error']
    dest = Path(args.out)
    dest.mkdir(parents=True, exist_ok=True)
    for node, outputs in (entry.get('outputs') or {}).items():
        for kind, items in outputs.items():
            for it in items if isinstance(items, list) else []:
                if not isinstance(it, dict) or 'filename' not in it:
                    continue
                q = urllib.parse.urlencode({'filename': it['filename'], 'subfolder': it.get('subfolder', ''), 'type': it.get('type', 'output')})
                status, data = call(base, 'GET', '/view?' + q, timeout=300)
                if status == 200 and isinstance(data, bytes):
                    path = dest / ('%s_%s' % (pid[:8], os.path.basename(it['filename'])))
                    path.write_bytes(data)
                    out['files'].append({'node': node, 'kind': kind, 'path': str(path), 'bytes': len(data)})
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out['ok'] else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--url', default=os.environ.get('COMFY_ATELIER', 'http://127.0.0.1:8188'), help='http://<IP Tailscale du PC GPU>:8188')
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run', help='jouer un graphe au format API')
    r.add_argument('workflow')
    r.add_argument('--image', action='append', help='NODE=fichier : envoyé, posé dans inputs.image du nœud')
    r.add_argument('--set', action='append', help='NODE.entrée=valeur')
    r.add_argument('--out', default='atelier-sorties')
    r.add_argument('--timeout', type=int, default=1800)
    sub.add_parser('status', help='carte, mémoire, file')
    m = sub.add_parser('models', help='dossiers de modèles, ou fichiers d\'un dossier')
    m.add_argument('folder', nargs='?')
    n = sub.add_parser('nodes', help='nœuds installés (/object_info), ou la définition d\'un nœud')
    n.add_argument('node', nargs='?')
    sub.add_parser('free', help='décharger les modèles (la carte est rendue)')
    sub.add_parser('interrupt', help='arrêter le calcul en cours')
    a = ap.parse_args()
    if a.cmd == 'run':
        return run(a.url, a)
    if a.cmd == 'status':
        out = {'system_stats': call(a.url, 'GET', '/system_stats')[1], 'queue': call(a.url, 'GET', '/queue')[1]}
        q = out['queue'] if isinstance(out['queue'], dict) else {}
        out['queue'] = {'running': len(q.get('queue_running') or []), 'pending': len(q.get('queue_pending') or [])}
    elif a.cmd == 'models':
        out = call(a.url, 'GET', '/models' + ('/' + urllib.parse.quote(a.folder) if a.folder else ''))[1]
    elif a.cmd == 'nodes':
        info = call(a.url, 'GET', '/object_info' + ('/' + urllib.parse.quote(a.node) if a.node else ''), timeout=120)[1]
        out = info if a.node else sorted(info) if isinstance(info, dict) else info
    elif a.cmd == 'free':
        out = {'http': call(a.url, 'POST', '/free', {'unload_models': True, 'free_memory': True})[0]}
    else:
        out = {'http': call(a.url, 'POST', '/interrupt', {})[0]}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except urllib.error.URLError as e:
        sys.exit('atelier injoignable (%s) : allumé ? adresse Tailscale du PC GPU ? ce PC est-il le poste client autorisé ?' % e.reason)
