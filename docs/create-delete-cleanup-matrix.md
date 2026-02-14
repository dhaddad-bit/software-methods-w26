# Create/Delete/Cleanup Matrix

| Domain Object | Create Path | Delete Path | Cleanup Path |
|---|---|---|---|
| Group membership | `POST /api/groups/:groupId/members` | `DELETE /api/groups/:groupId/members/:userId` | Group deletion cascades memberships |
| Group invite | `POST /api/groups/:groupId/invites` | `DELETE /api/groups/:groupId/invites/:inviteId` (revoke) | `backend/maintenance/cleanup.js` removes expired invites past retention |
| Petition | `POST /api/groups/:groupId/petitions` | `DELETE /api/petitions/:petitionId` (FAILED only) | Group deletion cascades petitions and responses |
| Notification | Emitted transactionally from petition create/respond | `DELETE /api/notifications/:notificationId` | `backend/maintenance/cleanup.js` removes read notifications past retention |
| Outbox message | Emitted transactionally with notifications | Implicit via parent notification delete (`ON DELETE CASCADE`) | `backend/maintenance/cleanup.js` removes old `SENT` and `DEAD` rows |
| Manual busy block | `POST /api/busy-blocks` | `DELETE /api/busy-blocks/:busyBlockId` | User/group cleanup via parent deletion cascades |
| Google event snapshot | `POST /api/google/sync` | Provider cancellation marks event status | Optional `cancelled_calendar_events` cleanup selector (policy gated) |

