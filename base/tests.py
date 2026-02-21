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

    def test_list_members(self):
        self.client.post(
            '/create_member/',
            data='{"name":"Alex","UID":"123","room_name":"ROOM1"}',
            content_type='application/json',
        )
        self.client.post(
            '/create_member/',
            data='{"name":"Sam","UID":"456","room_name":"ROOM1"}',
            content_type='application/json',
        )

        response = self.client.get('/list_members/', {'room_name': 'ROOM1'})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload['members']), 2)
        names = sorted(member['name'] for member in payload['members'])
        self.assertEqual(names, ['Alex', 'Sam'])


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


class RoomSessionTests(TestCase):
    def test_first_member_join_clears_old_chat_history(self):
        ChatMessage.objects.create(room_name='ROOMX', uid='old', name='Old', message='stale message')
        self.assertEqual(ChatMessage.objects.filter(room_name='ROOMX').count(), 1)

        create_response = self.client.post(
            '/create_member/',
            data='{"name":"Alex","UID":"111","room_name":"ROOMX"}',
            content_type='application/json',
        )
        self.assertEqual(create_response.status_code, 200)
        self.assertEqual(ChatMessage.objects.filter(room_name='ROOMX').count(), 0)

    def test_chat_clears_when_last_member_leaves(self):
        self.client.post(
            '/create_member/',
            data='{"name":"Alex","UID":"111","room_name":"ROOMY"}',
            content_type='application/json',
        )
        ChatMessage.objects.create(room_name='ROOMY', uid='111', name='Alex', message='hello')
        self.assertEqual(ChatMessage.objects.filter(room_name='ROOMY').count(), 1)

        delete_response = self.client.post(
            '/delete_member/',
            data='{"UID":"111","room_name":"ROOMY"}',
            content_type='application/json',
        )
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(RoomMember.objects.filter(room_name='ROOMY').count(), 0)
        self.assertEqual(ChatMessage.objects.filter(room_name='ROOMY').count(), 0)
