from django.urls import path
from . import views

urlpatterns = [
    path('', views.lobby),
    path('room/', views.room),
    path('get_token/', views.getToken),
    path('health/', views.healthCheck),

    path('create_member/', views.createMember),
    path('get_member/', views.getMember),
    path('delete_member/', views.deleteMember, name='delete_member'),
    path('create_message/', views.createMessage),
    path('get_messages/', views.getMessages),
]
