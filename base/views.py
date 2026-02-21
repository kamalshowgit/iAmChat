import json
import os
import random
import time

from agora_token_builder import RtcTokenBuilder
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods

from .models import ChatMessage, RoomMember



def lobby(request):
    return render(request, 'base/lobby.html')


def room(request):
    return render(request, 'base/room.html')


@require_GET
def getToken(request):
    app_id = os.getenv('AGORA_APP_ID', 'API')
    app_certificate = os.getenv('AGORA_APP_CERTIFICATE', 'appCertificate')
    channel_name = (request.GET.get('channel') or '').strip().upper()

    if not channel_name:
        return JsonResponse({'error': 'Missing channel name'}, status=400)

    if app_id in {'', 'API'} or app_certificate in {'', 'appCertificate'}:
        return JsonResponse({'error': 'Agora credentials are not configured'}, status=500)

    uid = random.SystemRandom().randint(1, 2147483647)
    expirationTimeInSeconds = 3600
    currentTimeStamp = int(time.time())
    privilegeExpiredTs = currentTimeStamp + expirationTimeInSeconds
    role = 1

    token = RtcTokenBuilder.buildTokenWithUid(
        app_id,
        app_certificate,
        channel_name,
        uid,
        role,
        privilegeExpiredTs,
    )

    return JsonResponse({'token': token, 'uid': uid, 'app_id': app_id})


@csrf_exempt
@require_http_methods(['POST'])
def createMember(request):
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    name = (data.get('name') or '').strip()
    uid = str(data.get('UID') or '').strip()
    room_name = (data.get('room_name') or '').strip().upper()

    if not name or not uid or not room_name:
        return JsonResponse({'error': 'name, UID, and room_name are required'}, status=400)

    member, _ = RoomMember.objects.update_or_create(
        uid=uid,
        room_name=room_name,
        defaults={'name': name, 'insession': True},
    )

    return JsonResponse({'name': member.name, 'uid': member.uid})


@require_GET
def getMember(request):
    uid = (request.GET.get('UID') or '').strip()
    room_name = (request.GET.get('room_name') or '').strip().upper()

    if not uid or not room_name:
        return JsonResponse({'error': 'UID and room_name are required'}, status=400)

    member = RoomMember.objects.filter(uid=uid, room_name=room_name).first()
    if not member:
        return JsonResponse({'error': 'Member not found'}, status=404)

    return JsonResponse({'name': member.name})


@csrf_exempt
@require_http_methods(['POST'])
def deleteMember(request):
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    uid = str(data.get('UID') or '').strip()
    room_name = (data.get('room_name') or '').strip().upper()

    if not uid or not room_name:
        return JsonResponse({'error': 'UID and room_name are required'}, status=400)

    deleted, _ = RoomMember.objects.filter(uid=uid, room_name=room_name).delete()
    if deleted:
        return JsonResponse({'status': 'Member deleted'})
    return JsonResponse({'error': 'Member not found'}, status=404)


@csrf_exempt
@require_http_methods(['POST'])
def createMessage(request):
    try:
        data = json.loads(request.body or '{}')
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    name = (data.get('name') or '').strip()[:200]
    uid = str(data.get('UID') or '').strip()
    room_name = (data.get('room_name') or '').strip().upper()
    message = (data.get('message') or '').strip()[:500]

    if not name or not uid or not room_name or not message:
        return JsonResponse({'error': 'name, UID, room_name, and message are required'}, status=400)

    chat_message = ChatMessage.objects.create(
        room_name=room_name,
        uid=uid,
        name=name,
        message=message,
    )

    return JsonResponse(
        {
            'id': chat_message.id,
            'uid': chat_message.uid,
            'name': chat_message.name,
            'message': chat_message.message,
            'created_at': int(chat_message.created_at.timestamp()),
        }
    )


@require_GET
def getMessages(request):
    room_name = (request.GET.get('room_name') or '').strip().upper()
    if not room_name:
        return JsonResponse({'error': 'room_name is required'}, status=400)

    try:
        after_id = int(request.GET.get('after_id', 0))
    except (TypeError, ValueError):
        return JsonResponse({'error': 'after_id must be an integer'}, status=400)

    try:
        limit = max(1, min(100, int(request.GET.get('limit', 50))))
    except (TypeError, ValueError):
        limit = 50

    if after_id > 0:
        queryset = ChatMessage.objects.filter(room_name=room_name, id__gt=after_id).order_by('id')[:limit]
    else:
        recent_ids = (
            ChatMessage.objects.filter(room_name=room_name)
            .order_by('-id')
            .values_list('id', flat=True)[:limit]
        )
        queryset = ChatMessage.objects.filter(id__in=recent_ids).order_by('id')
    messages = [
        {
            'id': message.id,
            'uid': message.uid,
            'name': message.name,
            'message': message.message,
            'created_at': int(message.created_at.timestamp()),
        }
        for message in queryset
    ]

    return JsonResponse({'messages': messages})


@require_GET
def healthCheck(request):
    try:
        RoomMember.objects.exists()
        ChatMessage.objects.exists()
    except Exception:
        return JsonResponse({'status': 'error'}, status=500)
    return JsonResponse({'status': 'ok'})
