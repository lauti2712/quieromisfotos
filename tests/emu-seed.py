# Crea los usuarios de tests/emu-users.json en el emulador de Auth (verificados).
import json, urllib.request, pathlib, secrets
f = pathlib.Path(__file__).parent / 'emu-users.json'
if not f.exists():
    f.write_text(json.dumps({'_nota': 'Usuarios SOLO del emulador local', 'password': 't' + secrets.token_hex(5),
                             'users': ['lautarom87@gmail.com', 'ana@test.local', 'beto@test.local']}, indent=2))
cfg = json.loads(f.read_text())
B = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
def post(path, body, admin=False):
    h = {'Content-Type': 'application/json'}
    if admin: h['Authorization'] = 'Bearer owner'
    r = urllib.request.Request(f'{B}/{path}?key=fake', data=json.dumps(body).encode(), headers=h)
    return json.load(urllib.request.urlopen(r))
for email in cfg['users']:
    u = post('accounts:signUp', {'email': email, 'password': cfg['password']})
    post('projects/quieromisfotos-71629/accounts:update', {'localId': u['localId'], 'emailVerified': True}, admin=True)
    print('ok', email)
