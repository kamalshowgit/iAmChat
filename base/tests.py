from django.test import TestCase

from .models import ChatMessage, RoomMember


class RoomMemberApiTests(TestCase):
    def test_create_get_delete_member(self):
        create_response = self.client.post(
            '/create_member/',
            data='{"name":"Alex","UID":"123","room_name":"ROOM1"}',
            content_type='application/json',
        )
        self.assertEqual(create_response.status_code, 200)
        self.assertEqual(RoomMember.objects.count(), 1)

        get_response = self.client.get('/get_member/', {'UID': '123', 'room_name': 'ROOM1'})
        self.assertEqual(get_response.status_code, 200)
        self.assertEqual(get_response.json()['name'], 'Alex')

        delete_response = self.client.post(
            '/delete_member/',
            data='{"UID":"123","room_name":"ROOM1"}',
            content_type='application/json',
        )
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(RoomMember.objects.count(), 0)


class ChatApiTests(TestCase):
    def test_create_and_fetch_messages(self):
        create_response = self.client.post(
            '/create_message/',
            data='{"name":"Alex","UID":"123","room_name":"ROOM1","message":"hello"}',
            content_type='application/json',
        )
        self.assertEqual(create_response.status_code, 200)
        self.assertEqual(ChatMessage.objects.count(), 1)

        get_response = self.client.get('/get_messages/', {'room_name': 'ROOM1', 'after_id': 0, 'limit': 50})
        self.assertEqual(get_response.status_code, 200)
        payload = get_response.json()
        self.assertEqual(len(payload['messages']), 1)
        self.assertEqual(payload['messages'][0]['message'], 'hello')
