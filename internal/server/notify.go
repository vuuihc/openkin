package server

import (
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/task"
)

// busNotifier gives the desktop channel its transport: a notification is a
// message on the same bus the console already listens to, so the shell needs no
// second connection and no polling.
//
// The message is attributed to the task's owner here rather than left to the
// bus, because a notify payload is not one of the row types the bus knows how
// to look up. Without the owner a scoped stream would drop the event, which is
// the one case where "someone needs you" would silently reach nobody.
type busNotifier struct {
	bus     *task.Bus
	ownerOf func(string) string
}

func (b busNotifier) PublishNotify(ev notify.Event) {
	if b.bus == nil {
		return
	}
	msg := task.WSMessage{Kind: "notify", Data: ev}
	// The event's own owner wins: routine and worker events have no task to
	// look up, and leaving the message unowned would make a scoped stream drop
	// the one announcement those events exist to deliver.
	msg.OwnerUserID = ev.OwnerUserID
	if msg.OwnerUserID == "" && ev.TaskID != "" && b.ownerOf != nil {
		msg.OwnerUserID = b.ownerOf(ev.TaskID)
	}
	b.bus.Publish(msg)
}
