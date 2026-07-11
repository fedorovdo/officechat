-- OfficeChat read-only integrity report for release checks.
-- Run with: docker compose exec -T postgres psql -U officechat -d officechat -f /tmp/integrity-report.sql

SELECT 'alembic_revision' AS check_name, version_num AS value FROM alembic_version;

SELECT 'orphaned_group_attachments' AS check_name, count(*)::text AS value
FROM message_attachments a
LEFT JOIN messages m ON m.id = a.message_id
WHERE m.id IS NULL;

SELECT 'orphaned_direct_attachments' AS check_name, count(*)::text AS value
FROM direct_message_attachments a
LEFT JOIN direct_messages m ON m.id = a.message_id
WHERE m.id IS NULL;

SELECT 'orphaned_discussion_attachments' AS check_name, count(*)::text AS value
FROM discussion_message_attachments a
LEFT JOIN discussion_messages m ON m.id = a.message_id
WHERE m.id IS NULL;

SELECT 'orphaned_pins' AS check_name, count(*)::text AS value
FROM pinned_messages p
LEFT JOIN messages gm ON p.chat_type = 'group' AND gm.id = p.message_id
LEFT JOIN direct_messages dm ON p.chat_type = 'direct' AND dm.id = p.message_id
LEFT JOIN discussion_messages dsm ON p.chat_type = 'discussion' AND dsm.id = p.message_id
WHERE gm.id IS NULL AND dm.id IS NULL AND dsm.id IS NULL;

SELECT 'orphaned_read_states' AS check_name, count(*)::text AS value
FROM chat_read_states r
LEFT JOIN users u ON u.id = r.user_id
WHERE u.id IS NULL;

SELECT 'sent_broadcasts_without_recipients' AS check_name, count(*)::text AS value
FROM broadcast_announcements b
LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id
WHERE b.status = 'sent'
GROUP BY b.id
HAVING count(r.id) = 0;

SELECT 'duplicate_permission_grants' AS check_name, count(*)::text AS value
FROM (
  SELECT user_id, permission_id
  FROM user_permissions
  GROUP BY user_id, permission_id
  HAVING count(*) > 1
) duplicates;

SELECT 'invalid_group_memberships' AS check_name, count(*)::text AS value
FROM group_members gm
LEFT JOIN users u ON u.id = gm.user_id
LEFT JOIN groups g ON g.id = gm.group_id
WHERE u.id IS NULL OR g.id IS NULL;
