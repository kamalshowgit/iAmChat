from django.db import models

class RoomMember(models.Model):
    name = models.CharField(max_length=200)
    uid = models.CharField(max_length=1000)
    room_name = models.CharField(max_length=200)
    insession = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['uid', 'room_name'], name='unique_member_per_room'),
        ]
        indexes = [
            models.Index(fields=['room_name']),
            models.Index(fields=['uid', 'room_name']),
        ]

    def __str__(self):
        return self.name


class ChatMessage(models.Model):
    room_name = models.CharField(max_length=200, db_index=True)
    uid = models.CharField(max_length=1000)
    name = models.CharField(max_length=200)
    message = models.TextField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['room_name', 'id']),
            models.Index(fields=['created_at']),
        ]
        ordering = ['id']

    def __str__(self):
        return f'{self.room_name}:{self.name}'
