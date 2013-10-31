/* Darkwind's Anti-Vandal Tool
 * Inspired by Lupin's Anti-Vandal Tool by [[User:Lupin]]
 * The RegEx generation function is from Lupin's Tool.
 *
 * Alpha version 0.0.3
 * License: GFDL 1.3 or later*, CC-BY-SA-3.0*, or EPL 1.0 (your choice)
 *
 * TODO: status indicator/display
 *  "dismiss here + all above" option (first implementation failed)
 *  Track users we attempt to roll back, and highlight their future edits as matches (like LAVT used to do)
 *
 * Known issues: timestamps don't always work -- sometimes they come out 00:00:00
 *  Navigation popups mostly don't seem to work on the page
 */
 
var AVT = new Object();
var AVTvandals = new Object();
var AVTconfig;

AVT.onLoad=function(){
    mw.util.addPortletLink("p-tb", "//en.wikipedia.org/wiki/User:Darkwind/DAVT/Filter", "Darkwind's AVT");
    var pageTitle = mw.config.get("wgTitle");
    if (pageTitle.search("DAVT") == -1) return; //only run on pages containing the string DAVT

    // now that we know to run the tool, set default config if the user doesn't already have settings in their *.js file
    if (!AVTconfig) {
        AVTconfig = {
            batchDelay: 30, //in seconds, how often should a new batch of diffs be processed? default of 30 mimics Lupin's AVT
            diffDelay: 90, //in seconds, how old is the newest edit we'll check? this helps avoid showing edits that ClueBotNG is about to undo, for example. This replaces "unchanged after 4 updates" option from LAVT.
            readDelay: 250, //in milliseconds, how long should we wait in between API calls? Note that this is not a strict rate limit.
            namespaces: "0|2", //a string, delimited by pipe, for which namespaces we want to monitor. See [[Wikipedia:Namespace]] for the list.
            showTypes: "!minor|!bot", //a string, delimited by pipe, for which edits we want to monitor. prefix the type with a ! to hide those edits.
            editTypes: "edit|new", //a string, delimited by pipe, for the type of edits we want to monitor "edit|new" means both edits and new pages - completely remove types you don't want
            showByDefault: 1 //show matching edits expanded by default? 1=yes, 0=no, show them collapsed
        };
    }
    AVT.count = 0;
    
    if (pageTitle.search("Filter") != -1) AVT.filterChanges(); //if page is DAVT/Filter, trigger Filter Changes procedure
    
    //TODO: Implement live spellcheck and watchlist 
};

AVT.filterChanges=function(){
    console.info("Entering filterChanges");
    if (!AVT.loadBadWords()) return 0; //first, load the "bad words" regex. if it fails, die.

    //next, set up the page
    //TODO: status indicator, *possibly* live checkboxes for options
    $("#mw-content-text").empty(); //blank the "page left blank" element
    $("#firstHeading span").text("Darkwind's Anti-Vandal Tool"); //Replace "Blank page" with the right heading
    $("#mw-content-text").append('<div id="DAVTcontent" style="line-height: 1.5em"></div>'); //add the empty DIV to contain all of our future output
    
    //Pause button
    var button = '<button id="AVTpause">Pause updates</button><br><hr>';
    $("#DAVTcontent").append(button);
    document.getElementById('AVTpause').addEventListener("click", AVT.pauseResume, false);
    
    //create a queue for diffs to download, as well as new pages
    pendingDiffs = new Queue();
    pendingNewPages = new Queue();
    
    //now, kick off the RC downloads    
    setTimeout(AVT.rcStop, 5400000); //stop the RC job after 90 minutes to prompt the user to continue
    AVT.rcDownloadFilter();
    
    //we're done here - the interval and timeout will take control
};

AVT.rcDownloadFilter=function(){
    if (AVT.paused) {
        console.log("AVT Paused");
        return; //abort if paused
    }    
    AVT.rcIsRunning = 1;
    var time1 = new Date();
    var time2 = new Date();
      
    time2.setTime(time1.getTime() - (AVTconfig.diffDelay * 1000)); //we only want recent changes older than diffDelay
    var timestamp = time2.toISOString(); //so let's generate a timestamp for our API query
    
    //okay, let's build a URL for our API query
    var queryURL = "/w/api.php?action=query&list=recentchanges&format=json&rcdir=older&rcprop=ids&rclimit=100&rctoponly="; //this part won't change
    queryURL += "&rcshow=" + AVTconfig.showTypes + "&rctype=" + AVTconfig.editTypes + "&rcnamespace=" + AVTconfig.namespaces + "&rcstart=" + timestamp;
    if (AVT.rcLastTime) queryURL += "&rcend=" + AVT.rcLastTime; //is there a timestamp to end at?
    AVT.rcLastTime = timestamp; //set the end timestamp for the next round - preventing overlap and duplicate diffs
    console.info(queryURL);
    
    $.ajax({ //pull the list of changes
        url: queryURL,
        dataType: "JSON",
        success: function (response) {
            console.info("Entering RC ajax success function");
            var edits = response.query.recentchanges; //an array of recent edits, containing several things but most importantly the revision ID for each change (revid)
            response.query.recentchanges.forEach( function (props, ind, array) {
                if (props.type == "new") pendingNewPages.enqueue(props.revid); //if the edit is a page creation, queue it up with new pages as they are handled differently
                    else pendingDiffs.enqueue(props.revid); //otherwise put it in the diff queue
            });
            
            //process the new page queue
            if (!pendingNewPages.isEmpty()) AVT.processNewPageFilterDiff();
            
            //process the diff queue
            if (!pendingDiffs.isEmpty()) AVT.processFilterDiff();
                
            //do this again in diffDelay seconds unless we've received a stop signal
            if (!AVT.rcStopSignal) setTimeout(AVT.rcDownloadFilter, (AVTconfig.diffDelay * 1000));
                else AVT.rcStopSignal = 0;
            AVT.rcIsRunning = 0;
        }
    });
};

AVT.processNewPageFilterDiff = function() {
    if (AVT.paused) {
        console.log("AVT Paused");
        return; //abort if paused
    }
    if (pendingNewPages.isEmpty()) return; //abort if the queue is now empty
    
    var revid = pendingNewPages.dequeue(); //pop the top revision off the new page queue
    var title, content, summary, timestamp, editor, matches, latestrev;
    timestamp = new Date();
    
    $.ajax({ //retrieve information about the page -- specifically, we're looking to see if this is still the latest revision.  If it isn't, let's not waste resources downloading the diff.
        url: "/w/api.php?action=query&prop=info&format=json&revids=" + revid,
        dataType: "JSON",
        async: false,
        success: function (response) {
            var temp = response.query.pages;
            var keys = Object.keys(temp);
            var key = keys[0];
            temp = temp[key];
            latestrev = temp.lastrevid; //store the latest revision and compare outside the ajax function for scope reasons
                
            
            if (revid != latestrev) {
                console.info("Not latest revision");
                if (pendingNewPages.isEmpty()) {
                    //TODO: status update to "done"
                    console.log("New page queue is empty");
                } else {
                    setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                    console.info("NP Queue length is: " + pendingNewPages.getLength());
                }
                return; //if they don't match, move on to the next item in the queue
            }
    
            console.info("Still latest, pulling full content");
    
            //since we're still working with the latest revision, let's get and process the diff
            $.ajax({
                url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=timestamp%7Cuser%7Cparsedcomment%7Ccontent&revids=" + revid,
                dataType: "JSON",
                success: function (response) {
                    var temp = response.query.pages;
                    var keys = Object.keys(temp);
                    var key = keys[0];
                    temp = temp[key];
                    title = temp.title;
                    temp = temp.revisions; //navigate down the JSON tree
                    
                    timestamp.setTime(Date.parse(temp.timestamp)); //parse the ISO timestamp returned by the server and store it in a date object
                    editor = temp.user;
                    summary = temp.parsedcomment;
                    content = temp["*"];             
                
    
                    console.info("Testing for a match");
                    
                    //now that we have our data, scan it
                    if (!badWords.test(content)) { //uses a fast method to test if there's a match at all; if there isn't, then go on to the next diff
                        console.info("No match");
                        if (pendingNewPages.isEmpty()) {
                            //TODO: status update to "done"
                            console.log("NP Queue is empty");
                        } else {
                            setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                            console.info("NP Queue length is: " + pendingNewPages.getLength());
                        }
                        return;
                    }
    
                    console.log("Match found");
                    
                    //since there's a match, we need to parse more thoroughly
                    matches = content.match(badWords); //get an array of the matches
                    content.replace(badWords, '<span style="background-color: yellow ! important">$&</span>'); //highlight each match in the content text for display
                    
                    AVT.diffDisplay(title, editor, timestamp, summary, matches, content, revid, 1); //call the function to add this revision to the user's display
                    
                    if (pendingNewPages.isEmpty()) {
                        //TODO: status update to "done"
                        console.log("New page queue is empty");
                        return;
                    } else {
                        setTimeout(AVT.processNewPageFilterDiff, AVTconfig.readDelay);
                        console.info("NP queue length is: " + pendingNewPages.getLength());
                    }
                }
            });
        }
    });
};

AVT.processFilterDiff = function() {
    if (AVT.paused) {
        console.log("AVT Paused");
        return; //abort if paused
    }
    if (pendingDiffs.isEmpty()) return; //abort if the queue is now empty
    
    var revid = pendingDiffs.dequeue(); //pop the top revision off the new page queue
    var title, content, diff, summary, timestamp, editor, matches, latestrev;
    timestamp = new Date();
    
    console.info("Revision is " + revid);
    
    $.ajax({ //retrieve information about the page -- specifically, we're looking to see if this is still the latest revision.  If it isn't, let's not waste resources downloading the diff.
        url: "/w/api.php?action=query&prop=info&format=json&revids=" + revid,
        dataType: "JSON",
        success: function (response) {
            var temp = response.query.pages;
            var keys = Object.keys(temp);
            var key = keys[0];
            temp = temp[key];
            latestrev = temp.lastrevid; //store the latest revision and compare outside the ajax function for scope reasons
        
    
            if (revid != latestrev) {
                console.info("Not latest revision");
                if (pendingDiffs.isEmpty()) {
                    //TODO: status update to "done"
                    console.log("Diff queue is empty");
                } else {
                    setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                    console.info("Diff queue length is: " + pendingDiffs.getLength());
                }
                return; //if they don't match, move on to the next item in the queue
            }
    
            console.info("Still latest, pulling full content");
            
            //since we're still working with the latest revision, let's get and process the diff
            $.ajax({
                url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=ids%7Ctimestamp%7Cuser%7Cparsedcomment%7Ccontent&rvdiffto=prev&revids=" + revid,
                dataType: "JSON",
                success: function (response) {
                    var temp = response.query.pages;
                    var keys = Object.keys(temp);
                    var key = keys[0];
                    temp = temp[key];
                    title = temp.title;
                    temp = temp.revisions[0]; //navigate down the JSON tree
                    
                    timestamp.setTime(Date.parse(temp.timestamp)); //parse the ISO timestamp returned by the server and store it in a date object
                    editor = temp.user;
                    summary = temp.parsedcomment;
                    content = temp["*"];
                    temp = temp.diff;
                    diff = temp["*"];
                            
                    console.info("Testing for a match");
                     
                    //in order to limit false positives from vandalism removal edits, scan the diff first
                    //if there's a match, then scan the wikitext of the page to make sure the vandalism is still there in the current revision
                    //if either test fails to return a match, return out of the function
                    
                    var abort;
                    
                    if (!badWords.test(diff)) {
                        abort = 1;//doesn't match in the diff, don't test the content
                    } else { 
                        if (!badWords.test(content)) {
                            abort = 1; //doesn't match in the content
                        }
                    }
                        
                    if (abort) { 
                        console.info("No match");
                        if (pendingDiffs.isEmpty()) {
                            //TODO: status update to "done"
                            console.log("Diff queue is empty");
                        } else {
                            setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                            console.info("Diff queue length is: " + pendingDiffs.getLength());
                        }
                        return;
                    }
                    
                    console.log("Match found");
                    
                    //since there's a match, we need to parse more thoroughly
                    matches = diff.match(badWords); //get an array of the matches (we're scanning the whole diff this time for display reasons)
                    
                    if (matches) matches = findUnique(matches); //filter out duplicates
                    //FIXME: matches is sometimes null here -- why? if there's no match, it should have been rejected up at the .test() call
                        
                    //diff.replace(badWords, '<span style="background-color: yellow">$&</span>'); //highlight each match in the content text for display (FIXME: doesn't work)
                    
                    diff = "<table>" + diff + "</table>"; //the diff sent by the server starts with <tr>'s, no table tags are included
                    
                    AVT.diffDisplay(title, editor, timestamp, summary, matches, diff, revid, 0); //call the function to add this revision to the user's display
                    
                    if (pendingDiffs.isEmpty()) {
                        //TODO: status update to "done"
                        console.log("Diff Queue is empty");
                        return;
                    } else {
                        setTimeout(AVT.processFilterDiff, AVTconfig.readDelay);
                        console.info("Diff queue length is: " + pendingDiffs.getLength());
                    }
                }
            });
        }
    });
};

AVT.diffDisplay = function(title, editor, timestamp, summary, matches, content, revid, isNewPage){ //function to generate and append the HTML to display a matching diff
    var newHTML, rollbackToken, rollbackLink, dismissLink, temptime;
    var timearray = new Array();
    
    if (!matches) return; //FIXME: why does matches come up null here from time to time?
    
    AVT.count++; //this function uses single quotes for strings for ease of dealing with HTML attributes
    
    newHTML = '<div id="AVTdiff' + AVT.count + '" class="diffDiv">' + '(' + AVT.count + ') '; //open the <div> with the next incremental count ID, and display the count
    
    newHTML += '[<a id="hidelink' + AVT.count + '" href="javascript:AVT.showHide(' + AVT.count + ')">'; //open hide/show link tag
    
    if (AVTconfig.showByDefault) { //add hide or show link and close tag
        newHTML += 'hide</a>] ';
    } else {
        newHTML += 'show</a>] ';
    }
    
    dismissLink = '[<a href="javascript:AVT.dismiss(' + AVT.count + ')">dismiss</a>] '; 
    //we're saving it to add it again at the bottom
    
    newHTML += dismissLink; //add dismiss link 

    //parse out the time components
    timearray[0] = timestamp.getUTCHours().toString();
    if (timearray[0].length == 1) timearray[0] = "0" + timearray[0]; //compensate for single digits
    timearray[1] = timestamp.getUTCMinutes().toString();
    if (timearray[1].length == 1) timearray[1] = "0" + timearray[1];
    timearray[2] = timestamp.getUTCSeconds().toString();
    if (timearray[2].length == 1) timearray[2] = "0" + timearray[2];
    
    temptime = timearray.join(":"); //now join the pieces together
    
    newHTML += temptime + ': '; //and add it
    
    if (isNewPage) {
        newHTML += 'New page '; //start the sentence with "new page"

        //next 3 lines perform escaping of the wikitext to prevent oddities if the editor used raw HTML tags or pseudo-tags like <nowiki> and  <ref>
        var escaped = content;
        var findReplace = [[/&/g, "&amp;"], [/</g, "&lt;"], [/>/g, "&gt;"], [/"/g, "&quot;"]];
        for(var item in findReplace) escaped = escaped.replace(findReplace[item][0], findReplace[item][1]);
        
        content = '<span style="font-family: monospace">' + escaped + '</span>'; //we want the wikitext monospaced, we have to do this after escaping to preserve the span tag
    } else {
        newHTML += 'Edit to page '; //no escaping is necessary for diffs, as the server should handle that already
    }
    
    newHTML += AVT.wikiLink(title) + " "; //add the title
    
    if (!isNewPage) { //if this is NOT a new page, add history, talk, and logs links
        newHTML += '(' + AVT.specialLink(title, "history") + ' | ' + AVT.specialLink(title, "talk") + ' | ' + AVT.specialLink(title, "logs") + ') ';
    }
 
    newHTML += 'matched <b>' + matches.join(', ') + "</b> "; //add article title and matches separated by a comma and space
        
    //retrieve rollback token for [rollback] link
    $.ajax({
        url: "/w/api.php?action=query&prop=revisions&format=json&rvtoken=rollback&revids=" + revid,
        dataType: "JSON",
        success: function (response) {
            var temp = response.query.pages;
            var keys = Object.keys(temp);
            var key = keys[0];
            temp = temp[key];
            temp = temp.revisions[0]; //navigate down the JSON tree
            rollbackToken = temp.rollbacktoken;
    
            //token returned by API has an extra slash at the end, remove it
            rollbackToken.slice(0, -1);
            
            //assemble rollback link
            rollbackLink = "https://en.wikipedia.org/w/index.php?title=" + title + "&action=rollback&from=" + editor + "&token=" + encodeURIComponent(rollbackToken);

            //add it to the HTML
            newHTML += '[<a href="' + rollbackLink + '" target="_blank">rollback</a>] ';
            newHTML += '<br>'; //go to second line
            
            if (isNewPage) {
                newHTML += 'Created by ';
            } else {
                newHTML += 'Edited by ';
            }
            
            //editor name and user research links
            newHTML += AVT.userLink(editor, "userpage") + ' (' + AVT.userLink(editor, "user talk", title) + ' | ' + AVT.userLink(editor, "contribs") + ' | ' + AVT.userLink(editor, "block log") + ' | ' + AVT.userLink(editor, "block") + ') ';
            
            //edit summary and move to the next line
            if (!summary) summary = "<small>No edit summary provided</small>";
            newHTML += 'Summary: (<i>' + summary + '</i>)<br>'; //TODO: links in the summary open in current tab - need to add "target='_blank'" to each <a> tag in the summary
            
            //now the content to display. this is wrapped in its own id'd DIV to allow collapse/expand functionality
            newHTML += '<div id="AVTextended' + AVT.count + '">' + content + dismissLink + '</div>';
            
            //now an HR to end the listing and close the outer DIV
            newHTML += '<br><hr></div>';
            
            //add the new HTML to the page
            $("#DAVTcontent").append(newHTML);
            
            if (!AVTconfig.showByDefault) { //hide the diff if the setting calls for that
                $("#AVTextended" + AVT.count).css("display", "none");
            }
        }
    });
};

AVT.loadBadWords=function(){ //request the bad words wiki page from the API -- keeping the regexen on wiki allows for easy updating
    $.ajax({ 
        url: "/w/api.php?action=query&prop=revisions&format=json&rvprop=content&rvlimit=1&rvcontentformat=text%2Fx-wiki&titles=User%3ADarkwind%2FDAVT%2Fbadwords", 
        dataType: "JSON",
        async: false,
        success: function (response) {
            var raw1 = response.query.pages["40929001"]; //traverse the API's excessively complicated JSON response
            var raw2 = raw1.revisions[0]; //which uses non-standard identifiers
            var raw3 = raw2["*"]; //making stuff like this necessary
            
            var data = raw3.split("\n"); //now split the page data into an array, each line in its own element
            
            var phrase=[]; //declare variables used when parsing the badword list
            var string=[];
            
            for (var i=0; i<data.length; ++i) {
                var s=data[i];

                // ignore empty lines, whitespace-only lines and lines starting with '<'
                if (/^\s*$|^</.test(s)) { continue; }

                // lines beginning and ending with a (back-)slash (and possibly trailing
                // whitespace) are treated as regexps
                if (/^([\\\/]).*\1\s*$/.test(s)) {
                    var isPhrase=(s.charAt(0)=='/');
                    // remove slashes and trailing whitespace
                    s=s.replace(/^([\\\/])|([\\\/]\s*$)/g, '');
                    // escape opening parens: ( -> (?:
                    s=s.replace(/\(?!\?/g, '(?:');
                    // check that s represents a valid regexp
                    try { var r=new RegExp(s); }
                    catch (err) {
                        var errDiv=newOutputDiv('recent2_error', recent2.outputPosition);
                        errDiv.innerHTML='Warning: ignoring odd-looking regexp on line '+i+
                            ' of <a href="' + mw.util.wikiGetlink(recent2.badwordsUrl) +
                            '">badwords</a>:<pre>' + s + '</pre>';
                        continue;
                    }
                    if (isPhrase) {
                        phrase.push(s);
                    } else {
                        string.push(s);
                    }
                } else {
                    // treat this line as a non-regexp and escape it.
                    phrase.push(s.replace(RegExp('([-|.()\\+:!,?*^${}\\[\\]])', 'g'), '\\$1'));
                }
            }
            //                      123                                3       2|4                        4|5         56                        67        71
            //                      (((    repeated char               )       )|(   ... | strings | ...  )|( border  )(   ... | phrases | ...  )( border ))
            badWords = RegExp("((([^\\-\\|\\{\\}\\].\\s'=wI:*#0-9a-f])\\3{2,})|(" + string.join('|') + ")|(^|[^/\\w])(" + phrase.join('|') + ")(?![/\\w]))", 'gi');
        }
    });
    return 1;
};

AVT.rcStop=function(){ //a function callable via setTimeout (or otherwise) to end the RC download/parse process
    AVT.rcStopSignal = 1;
};

AVT.wikiLink = function(pageTitle) { //takes an article title (with spaces and namespace), converts it to a full URL, and returns it wrapped with an <a> tag.
    var URL, HTML, originalTitle;
    originalTitle = pageTitle; 
    pageTitle = pageTitle.replace(" ", "_", "g"); //replace spaces with underscores
    encodeURIComponent(pageTitle); //now encode it
    URL = "https://en.wikipedia.org/wiki/" + pageTitle;
    HTML = '<a href="' + URL + '" target="_blank">' + originalTitle + '</a>';
    return HTML;
};

AVT.specialLink = function(pageTitle, pageType, display) { //takes an article title and returns a link to the specified special page, including <a> tag and word(s) to display
    var URL, HTML;
    pageTitle = pageTitle.replace(" ", "_", "g"); //replace spaces with underscores
    encodeURIComponent(pageTitle); //now encode it
    
    switch (pageType) {
        case "history":
            URL = "https://en.wikipedia.org/w/index.php?title=" + pageTitle + "&action=history";
            break;
        case "talk":
            URL = "https://en.wikipedia.org/wiki/Talk:" + pageTitle;
            break;
        case "logs":
            URL = "https://en.wikipedia.org/w/index.php?title=Special:Log&page=" + pageTitle;
            break;
    }
    
    if (display) { //if there's a string for the display title, use it, otherwise use the pageType
        HTML = '<a href="' + URL + '" target="_blank">' + display + '</a>';
    } else {
        HTML = '<a href="' + URL + '" target="_blank">' + pageType + '</a>';
    }
    
    return HTML;
};

AVT.userLink = function(userName, pageType, pageTitle, display) {
    var URL, HTML, originalName;
    originalName = userName;
    userName = userName.replace(" ", "_", "g"); //replace spaces with underscores
    //we do not similarly escape the pageTitle in this function because TW takes the underscores literally
    encodeURIComponent(userName); //now encode it

    switch (pageType) {
        case "userpage":
            URL = "https://en.wikipedia.org/wiki/User:" + userName;
            if (!display) display = originalName;
            break;
        case "user talk": //includes a parameter for TW users to populate the article title when warning or welcoming
            URL = "https://en.wikipedia.org/wiki/User_talk:" + userName + "?vanarticle=" + pageTitle;
            if (!display) display = "talk";
            break;
        case "contribs":
            URL = "https://en.wikipedia.org/wiki/Special:Contributions/" + userName;
            if (!display) display = "contribs";
            break;
        case "block log":
            URL = "https://en.wikipedia.org/w/index.php?title=Special:Log/block&page=User:" + userName;
            if (!display) display = "block log";
            break;
        case "block":
            URL = "https://en.wikipedia.org/wiki/Special:Block/" + userName;
            if (!display) display = "block";
            break;
    }
    
    HTML = '<a href="' + URL + '" target="_blank">' + display + '</a>';
    return HTML;
};

AVT.showHide = function(div) {
    var linkText = $("#hidelink" + div).text();
    console.log("linkText for div " + div + " is " + linkText);
    switch (linkText) {
        case "hide":
            $("#AVTextended" + div).css("display", "none");
            $("#hidelink" + div).text("show");
            break;
        case "show":
            $("#AVTextended" + div).css("display", "inline");
            $("#hidelink" + div).text("hide");
            break;
    }
};

AVT.dismiss = function(div) {
    $("#AVTdiff" + div).remove(); //remove the requested div
    $("#AVTdiff" + (div + 1)).scrollintoview(); //scroll the subsequent div to the top of the page - will only work if you haven't been removing divs out of sequence
};

AVT.rollback = function(editor, title, token) { //this function does NOT implement a rollback feature - this is used for vandal tracking
    var rollURL = "https://en.wikipedia.org/w/index.php?title=" + title + "&action=rollback&from=" + editor + "&token=" + encodeURIComponent(token); //compose rollback URL
    window.open(rollURL, "_blank"); //open it in a new page to perform the rollback
    
    //regardless of whether or not the rollback succeeded, we want to track it
    if (AVTvandals.hasOwnProperty(editor)) AVTvandals[editor] += 1; //if we've already recorded them, increment their rollback counter
        else AVTvandals[editor] = 1; //otherwise, create their entry, set to 1
}

AVT.pauseResume = function() {
    if (!AVT.paused) {
        AVT.paused = 1;
        $("#AVTpause").text("Resume updates");
    } else {
            AVT.paused = 0;
            console.log("AVT resuming");
            $("AVTpause").text("Pause updates");
            AVT.rcDownloadFilter(); //re-trigger the AVT processing
        }
};

$(document).ready(AVT.onLoad); //trigger the initial script processing when the page is done loading

function findUnique(arr) { 
    return $.grep(arr,function(v,k){
        return $.inArray(v,arr) === k;
    });
}

function Queue(){ //queue library (found online licensed as CC-zero)
var _1=[];
var _2=0;
this.getLength=function(){
return (_1.length-_2);
};
this.isEmpty=function(){
return (_1.length==0);
};
this.enqueue=function(_3){
_1.push(_3);
};
this.dequeue=function(){
if(_1.length==0){
return undefined;
}
var _4=_1[_2];
if(++_2*2>=_1.length){
_1=_1.slice(_2);
_2=0;
}
return _4;
};
this.peek=function(){
return (_1.length>0?_1[_2]:undefined);
};
};

/*
* jQuery scrollintoview() plugin and :scrollable selector filter
*
* Version 1.8 (14 Jul 2011)
* Requires jQuery 1.4 or newer
*
* Copyright (c) 2011 Robert Koritnik
* Licensed under the terms of the MIT license
* http://www.opensource.org/licenses/mit-license.php
*/
(function(f){var c={vertical:{x:false,y:true},horizontal:{x:true,y:false},both:{x:true,y:true},x:{x:true,y:false},y:{x:false,y:true}};var b={duration:"fast",direction:"both"};var e=/^(?:html)$/i;var g=function(k,j){j=j||(document.defaultView&&document.defaultView.getComputedStyle?document.defaultView.getComputedStyle(k,null):k.currentStyle);var i=document.defaultView&&document.defaultView.getComputedStyle?true:false;var h={top:(parseFloat(i?j.borderTopWidth:f.css(k,"borderTopWidth"))||0),left:(parseFloat(i?j.borderLeftWidth:f.css(k,"borderLeftWidth"))||0),bottom:(parseFloat(i?j.borderBottomWidth:f.css(k,"borderBottomWidth"))||0),right:(parseFloat(i?j.borderRightWidth:f.css(k,"borderRightWidth"))||0)};return{top:h.top,left:h.left,bottom:h.bottom,right:h.right,vertical:h.top+h.bottom,horizontal:h.left+h.right}};var d=function(h){var j=f(window);var i=e.test(h[0].nodeName);return{border:i?{top:0,left:0,bottom:0,right:0}:g(h[0]),scroll:{top:(i?j:h).scrollTop(),left:(i?j:h).scrollLeft()},scrollbar:{right:i?0:h.innerWidth()-h[0].clientWidth,bottom:i?0:h.innerHeight()-h[0].clientHeight},rect:(function(){var k=h[0].getBoundingClientRect();return{top:i?0:k.top,left:i?0:k.left,bottom:i?h[0].clientHeight:k.bottom,right:i?h[0].clientWidth:k.right}})()}};f.fn.extend({scrollintoview:function(j){j=f.extend({},b,j);j.direction=c[typeof(j.direction)==="string"&&j.direction.toLowerCase()]||c.both;var n="";if(j.direction.x===true){n="horizontal"}if(j.direction.y===true){n=n?"both":"vertical"}var l=this.eq(0);var i=l.closest(":scrollable("+n+")");if(i.length>0){i=i.eq(0);var m={e:d(l),s:d(i)};var h={top:m.e.rect.top-(m.s.rect.top+m.s.border.top),bottom:m.s.rect.bottom-m.s.border.bottom-m.s.scrollbar.bottom-m.e.rect.bottom,left:m.e.rect.left-(m.s.rect.left+m.s.border.left),right:m.s.rect.right-m.s.border.right-m.s.scrollbar.right-m.e.rect.right};var k={};if(j.direction.y===true){if(h.top<0){k.scrollTop=m.s.scroll.top+h.top}else{if(h.top>0&&h.bottom<0){k.scrollTop=m.s.scroll.top+Math.min(h.top,-h.bottom)}}}if(j.direction.x===true){if(h.left<0){k.scrollLeft=m.s.scroll.left+h.left}else{if(h.left>0&&h.right<0){k.scrollLeft=m.s.scroll.left+Math.min(h.left,-h.right)}}}if(!f.isEmptyObject(k)){if(e.test(i[0].nodeName)){i=f("html,body")}i.animate(k,j.duration).eq(0).queue(function(o){f.isFunction(j.complete)&&j.complete.call(i[0]);o()})}else{f.isFunction(j.complete)&&j.complete.call(i[0])}}return this}});var a={auto:true,scroll:true,visible:false,hidden:false};f.extend(f.expr[":"],{scrollable:function(k,i,n,h){var m=c[typeof(n[3])==="string"&&n[3].toLowerCase()]||c.both;var l=(document.defaultView&&document.defaultView.getComputedStyle?document.defaultView.getComputedStyle(k,null):k.currentStyle);var o={x:a[l.overflowX.toLowerCase()]||false,y:a[l.overflowY.toLowerCase()]||false,isRoot:e.test(k.nodeName)};if(!o.x&&!o.y&&!o.isRoot){return false}var j={height:{scroll:k.scrollHeight,client:k.clientHeight},width:{scroll:k.scrollWidth,client:k.clientWidth},scrollableX:function(){return(o.x||o.isRoot)&&this.width.scroll>this.width.client},scrollableY:function(){return(o.y||o.isRoot)&&this.height.scroll>this.height.client}};return m.y&&j.scrollableY()||m.x&&j.scrollableX()}})})(jQuery);