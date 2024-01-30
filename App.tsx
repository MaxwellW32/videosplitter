import { useState, useRef, useMemo, useEffect } from 'react';
import { StyleSheet, Text, View, SafeAreaView, StatusBar, ScrollView, Image, Pressable, TextInput, Alert, TouchableOpacity, Button, Platform } from 'react-native';
import Share from 'react-native-share';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Video, ResizeMode } from 'expo-av';
import { FFmpegKit } from 'ffmpeg-kit-react-native';
import Slider from '@react-native-community/slider';
import ArrowCircle from './components/resuables/svgs/ArrowCircle';
import ArrowLeft from './components/resuables/svgs/ArrowLeft';
import ShareSvg from './components/resuables/svgs/ShareSvg';
import Cog from './components/resuables/svgs/Cog';

const splitVideosOutputDir = FileSystem.documentDirectory + "split-videos/"
const intermediateOutputDir = FileSystem.documentDirectory + "intermediate/"

export default function App() {
  type uploadedVideo = {
    uri: string,
    filename: string,
  }
  type videoControlsType = {
    startTime: number,
    endTime: number,
    currentTime: number,
    maxTime: number,
    scale: "144" | "360" | "720" | "1080" | null,
    rotate: 90 | -90 | 180 | null,
    amtToSegment: number,
  }
  const [uploadedVideoInfo, uploadedVideoInfoSet] = useState<uploadedVideo | null>(null);
  const [splitVideoUris, splitVideoUrisSet] = useState<string[]>([]);
  const [currentBarSelected, currentBarSelectedSet] = useState<"start" | "end">("start");
  const [showingSettings, showingSettingsSet] = useState(false);
  const [editingSegmentTime, editingSegmentTimeSet] = useState(false);

  const [runningVideoSplitInfo, runningVideoSplitInfoSet] = useState<{
    running: boolean,
    duration: number | null,
    errorSeen: string[] | null
  }>({
    running: false,
    duration: null,
    errorSeen: null
  });

  const inputTimeout = useRef<NodeJS.Timeout>()
  const smalltTimeChangeTimeout = useRef<NodeJS.Timeout>()
  const previewVideo = useRef<Video>(null!)
  const [videoControls, videoControlsSet] = useState<videoControlsType>({
    startTime: 0,
    endTime: 0,
    currentTime: 0,
    maxTime: 0,
    scale: null,
    rotate: null,
    amtToSegment: 30,
  })

  const millToTime = (milliseconds: number) => {
    let seconds = Math.floor(milliseconds / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);

    seconds = seconds % 60;
    minutes = minutes % 60;

    const returningArr = [
      hours.toString().padStart(2, '0'),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0'),
    ]

    return returningArr.join(':');
  }

  const videoDuration = useMemo(() => {
    if (!videoControls) return 0

    if (videoControls.startTime > videoControls.endTime) return 0

    return videoControls.endTime - videoControls.startTime
  }, [videoControls])

  const usingAFilter = useMemo(() => {
    return videoControls.rotate !== null || videoControls.scale !== null
  }, [videoControls])

  const onStartTimeChange = (startTime: number) => {
    videoControlsSet(prev => {
      const newControls = { ...prev }
      newControls.startTime = startTime

      if (newControls.startTime > newControls.endTime) {
        return prev
      }

      return newControls
    })
  };

  const onEndTimeChange = (endTime: number) => {
    videoControlsSet(prev => {
      const newControls = { ...prev }
      newControls.endTime = endTime

      if (newControls.endTime < newControls.startTime) {
        newControls.endTime = newControls.startTime
      }
      return newControls
    });
  }

  const uploadVideo = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos
    });
    if (!result.assets) return

    const seenUri = result.assets[0].uri

    uploadedVideoInfoSet({
      uri: seenUri,
      filename: result.assets[0].fileName ?? "splitVideo"
    })

    videoControlsSet(prevControls => {
      return {
        ...prevControls,
        startTime: 0,
        currentTime: 0,
        endTime: result.assets[0].duration,
        maxTime: result.assets[0].duration
      }
    })
  };

  const ensureDirExists = async (directUri: string) => {
    const dirInfo = await FileSystem.getInfoAsync(directUri);

    if (!dirInfo.exists) {
      console.log(`directory ${directUri} doesn't exist, creating…`);
      await FileSystem.makeDirectoryAsync(directUri, { intermediates: true }).then(() => {
        console.log(`$successfully created directory`);
      }).catch(error => {
        console.log(`$error creating`, error);
      });
    } else {
      console.log(`$directory ${directUri} confirmed`);
    }

    return dirInfo
  }

  const retrieveFromDirectory = async (passedUri: string): Promise<string[] | null> => {
    try {
      const seenUris = await FileSystem.readDirectoryAsync(passedUri)
      if (seenUris.length === 0) return null

      return seenUris;

    } catch (error) {
      console.log(`$error trying to read this direct ${passedUri}`, error);
      return null
    }
  }

  const deleteInDirectory = async (passedUri: string) => {
    await FileSystem.deleteAsync(passedUri).catch(e => {
      console.log(`couldn't delete directory`, e);
    })
  }

  const splitVideo = async (uploadedVideo: uploadedVideo, seenOutputDir: string, seenIntermediateDir: string, seenVideoControls: videoControlsType, seenDuration: number, seenUsingAFilter: boolean) => {
    try {
      await ensureDirExists(seenOutputDir)
      runningVideoSplitInfoSet(prev => {
        return { ...prev, errorSeen: null, running: true, duration: null }
      })

      const rotateFilter = seenVideoControls.rotate === null ? "" :
        seenVideoControls.rotate === 90 ? `transpose=1,` :
          seenVideoControls.rotate === -90 ? `transpose=2,` :
            `rotate=PI:bilinear=0,`
      const scaleFilter = seenVideoControls.scale === null ? "" :
        rotateFilter
          ?
          rotateFilter === "rotate=PI:bilinear=0," ? `scale=-1:${seenVideoControls.scale}` :
            `scale=${seenVideoControls.scale}:-1`
          :
          `scale=-1:${seenVideoControls.scale}`

      const allFilters = `${rotateFilter}${scaleFilter}`

      const adjustedSegmentTime = seenVideoControls.amtToSegment > 1 ? seenVideoControls.amtToSegment - 1 : seenVideoControls.amtToSegment

      const finalCommand = seenUsingAFilter ?
        `-loglevel error -ss ${millToTime(seenVideoControls.startTime)} -t ${millToTime(seenDuration)} -i ${uploadedVideo.uri} -c:v libx264 -crf 18 -vf "${allFilters}" -map 0 -segment_time ${adjustedSegmentTime} -g ${adjustedSegmentTime} -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${adjustedSegmentTime})" -reset_timestamps 1 -f segment ${seenOutputDir}${uploadedVideo.filename}%03d.mp4` :
        `-loglevel error -ss ${millToTime(seenVideoControls.startTime)} -t ${millToTime(seenDuration)} -i ${uploadedVideo.uri} -c copy -map 0 -segment_time ${seenVideoControls.amtToSegment} -reset_timestamps 1 -f segment ${seenOutputDir}${uploadedVideo.filename}%03d.mp4`

      await FFmpegKit.execute(finalCommand).then(async session => {
        const returnCode = await session.getReturnCode();
        const duration = await session.getDuration();
        const failStackTrace = await session.getFailStackTrace();

        if (returnCode.isValueSuccess()) {
          console.log(`Encode completed successfully in ${duration} milliseconds;`);

          runningVideoSplitInfoSet(prev => {
            return { ...prev, duration: duration }
          })
        } else if (returnCode.isValueCancel()) {
          console.log('Encode canceled');
        } else {
          console.log(
            `failed and rc ${returnCode}.${failStackTrace}`,
          );

          runningVideoSplitInfoSet(prev => {
            return { ...prev, errorSeen: prev.errorSeen ? [...prev.errorSeen, `failed and rc ${returnCode}.${failStackTrace}`] : [`failed and rc ${returnCode}.${failStackTrace}`] }
          })
        }
      });

      setTimeout(() => {
        runningVideoSplitInfoSet(prev => {
          if (prev.errorSeen !== null) {
            return prev
          } else {
            return { ...prev, running: false }
          }
        })
      }, 1000);
    } catch (error) {
      console.log(`$error splitting vid`, error);
    }
  };

  const onShare = async (seenUris: string[], singleShare = false) => {
    if (seenUris.length === 0) return

    if (singleShare) {
      const shareResponse = await Share.open({
        url: seenUris[0],
      })

      if (shareResponse.success) {
        console.log(`$successfully shared`);
      }

    } else {
      const shareResponse = await Share.open({
        urls: seenUris,
      })

      if (shareResponse.success) {
        console.log(`$successfully shared`);
      }
    }
  };

  const handleWantsToSplit = async () => {
    //reset clean
    const prevVideoUris = await retrieveFromDirectory(splitVideosOutputDir)
    if (prevVideoUris) {
      await deleteInDirectory(splitVideosOutputDir);
      splitVideoUrisSet([]);
    }

    const prevIntermediateUris = await retrieveFromDirectory(intermediateOutputDir)
    if (prevIntermediateUris) {
      await deleteInDirectory(intermediateOutputDir);
    }

    //split video
    await splitVideo(uploadedVideoInfo, splitVideosOutputDir, intermediateOutputDir, videoControls, videoDuration, usingAFilter)

    const seenSplitVideoUris = await retrieveFromDirectory(splitVideosOutputDir)
    splitVideoUrisSet(seenSplitVideoUris)
  }

  const onPlaybackStatusUpdate = (status: any, seenVideoControls: videoControlsType) => {
    if (status.positionMillis >= seenVideoControls.endTime) {
      previewVideo.current.playFromPositionAsync(seenVideoControls.startTime)
    }
  }

  const changeRotation = (option: 90 | -90 | 180 | null) => {
    const translatedOption = option === null ? 90 :
      option === 90 ? 180 :
        option === 180 ? -90 :
          null

    videoControlsSet(prev => {
      return { ...prev, rotate: translatedOption }
    })
  }

  const changeResolution = (option: "144" | "360" | "720" | "1080" | null, direction: "left" | "right") => {
    const optionsArr = ["144", "360", "720", "1080", null]
    const foundIndex = optionsArr.findIndex(each => each === option)
    let usingOption = null
    let newIndex = 0

    if (direction === "left") {
      newIndex = foundIndex - 1
      if (newIndex < 0) newIndex = optionsArr.length - 1
    } else {
      newIndex = foundIndex + 1
      if (newIndex > optionsArr.length - 1) newIndex = 0
    }

    usingOption = optionsArr[newIndex]

    videoControlsSet(prev => {
      return { ...prev, scale: usingOption }
    })
  }

  const changeTimeSmall = async (option: "back" | "forward", seenCurrentBarSelected: "start" | "end", videoRef: Video) => {
    if (smalltTimeChangeTimeout.current) clearTimeout(smalltTimeChangeTimeout.current)
    let newTime = 0

    videoControlsSet((prevVideoControls) => {
      const transformDirection = option === "back" ? -100 : 100

      if (seenCurrentBarSelected === "start") {
        newTime = prevVideoControls.startTime + transformDirection
        if (newTime < 0 || newTime > prevVideoControls.endTime) newTime = prevVideoControls.startTime

        return { ...prevVideoControls, startTime: newTime }
      } else {
        newTime = prevVideoControls.endTime + transformDirection
        if (newTime > prevVideoControls.maxTime || newTime < prevVideoControls.startTime) newTime = prevVideoControls.endTime
        return { ...prevVideoControls, endTime: newTime }
      }
    })

    smalltTimeChangeTimeout.current = setTimeout(async () => {
      await previewVideo.current.pauseAsync()
      videoRef.setPositionAsync(newTime)
    }, 500)
  }

  return (
    <SafeAreaView style={styles.appContainer}>
      <StatusBar barStyle="light-content" backgroundColor={"#242734"} />

      <View style={{ flex: .5, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 8 }}>
        <Image
          style={{ width: 50, aspectRatio: "1/1", borderRadius: 8 }}
          source={require("./assets/logo.png")}
        />

        <Text style={{ fontWeight: "bold", fontSize: 32, color: "#fff" }}>Story Slice</Text>

        <Pressable onPress={() => { showingSettingsSet(prev => !prev) }}>
          <Cog style={styles.svg} fill={showingSettings ? "#D6E5E3" : "#fff"} />
        </Pressable>
      </View>

      <View style={{ backgroundColor: "#A6B1E1", flex: 2, flexDirection: "row", gap: 8, padding: 8, position: "relative" }}>
        <View style={{ display: showingSettings ? "flex" : "none", flex: .6, gap: 8 }}>
          <Pressable style={[styles.settingsContSmall, { justifyContent: 'center', alignItems: 'center' }]} onPress={() => changeRotation(videoControls.rotate)}>
            <ArrowCircle height={40} width={40} rotation={videoControls.rotate === null ? -90 : videoControls.rotate === 90 ? 0 : videoControls.rotate === 180 ? 90 : 180} />
          </Pressable>

          <View style={[styles.settingsContSmall, { justifyContent: "center", alignItems: "center", position: 'relative' }]}>
            <Pressable onPress={() => { changeResolution(videoControls.scale, "left") }}>
              <ArrowLeft height={40} width={40} />
            </Pressable>

            <Text style={{}}>{videoControls.scale === null ? "Native" : `${videoControls.scale}p`}</Text>

            <Pressable style={{}} onPress={() => { changeResolution(videoControls.scale, "right") }}>
              <ArrowLeft height={40} width={40} rotation={180} />
            </Pressable>
          </View>

          <Pressable onPress={() => { editingSegmentTimeSet(true) }} style={[styles.settingsContSmall, { justifyContent: "center", alignItems: "center", position: 'relative' }]}>
            <Text style={{ fontWeight: "bold" }}>{isNaN(videoControls.amtToSegment) ? "" : `${videoControls.amtToSegment}s`}</Text>

            <Text style={{ fontWeight: "bold" }}>split</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1.5, position: "relative", }}>
          <View style={{ display: showingSettings ? "flex" : "none", alignItems: "center" }}>
            <Text style={{ opacity: videoControls.rotate === null ? 0 : 1, textAlign: "center", fontSize: 8 }}>rotate video {videoControls.rotate === 90 ? 90 : videoControls.rotate === 180 ? 180 : 270} degrees</Text>
            <Text>Duration: {millToTime(videoDuration)}s</Text>

            <Text>Move <Text style={{ fontWeight: "bold" }}>{currentBarSelected}</Text> 100ms</Text>

            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity activeOpacity={0.8} style={{ backgroundColor: '#dcd6f7', marginTop: 8, padding: 8, borderRadius: 8, }} onPress={() => changeTimeSmall("back", currentBarSelected, previewVideo.current)}>
                <Text style={{ fontWeight: "bold" }}>backward</Text>
              </TouchableOpacity>

              <TouchableOpacity activeOpacity={0.8} style={{ backgroundColor: '#dcd6f7', marginTop: 8, padding: 8, borderRadius: 8, }} onPress={() => changeTimeSmall("forward", currentBarSelected, previewVideo.current)}>
                <Text style={{ fontWeight: "bold" }}>forward</Text>
              </TouchableOpacity>
            </View>
          </View>

          {uploadedVideoInfo ? (
            <Video
              style={{ flex: 1 }}
              ref={previewVideo}
              source={{ uri: uploadedVideoInfo.uri }}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              isLooping
              onPlaybackStatusUpdate={(e) => { onPlaybackStatusUpdate(e, videoControls) }}
            />
          ) : (
            <View style={{ alignItems: "center", justifyContent: "center", flex: 1 }}>
              <Text style={{ fontSize: 30, fontWeight: "bold", color: "#fff" }}>Get Started</Text>
              <Text style={{ fontSize: 20, fontWeight: "bold", color: "#fff" }}>Upload a video below</Text>
            </View>
          )}
        </View>

        <View style={{ display: showingSettings ? "flex" : "none", opacity: showingSettings ? 1 : 0, flex: 1, position: "relative", justifyContent: "space-between", alignItems: "center" }}>
          <Text>{millToTime(videoControls.startTime)}</Text>

          <View style={{ transform: [{ rotate: "90deg" }], position: "absolute", top: 115, left: -65, width: 250, gap: 32 }}>
            <Slider
              onSlidingComplete={async () => {
                currentBarSelectedSet("end")
                await previewVideo.current.pauseAsync()
                previewVideo.current.setPositionAsync(videoControls.endTime)
              }}
              step={1}
              value={videoControls.endTime}
              minimumValue={1}
              maximumValue={videoControls.maxTime}
              onValueChange={onEndTimeChange}
              minimumTrackTintColor="#FFFFFF"
              maximumTrackTintColor="#000000"
            />

            <Slider
              onSlidingStart={() => {
                previewVideo.current.pauseAsync()
              }}
              onSlidingComplete={async () => {
                currentBarSelectedSet("start")
                await previewVideo.current.setPositionAsync(videoControls.startTime)
                previewVideo.current.playAsync()
              }}
              step={1}
              value={videoControls.startTime}
              minimumValue={0}
              maximumValue={videoControls.maxTime}
              onValueChange={onStartTimeChange}
              minimumTrackTintColor="#FFFFFF"
              maximumTrackTintColor="#000000"
            />
          </View>

          <Text>{millToTime(videoControls.endTime)}</Text>
        </View>

        {editingSegmentTime && (
          <Pressable onPress={() => {
            editingSegmentTimeSet(false)

            if (isNaN(videoControls.amtToSegment)) {
              videoControlsSet(prev => {
                return {
                  ...prev,
                  amtToSegment: 30
                }
              })
            }

          }} style={{ position: "absolute", top: 0, left: 0, bottom: 0, right: 0, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", zIndex: 10 }}>

            <Pressable onPress={(e) => {
              e.stopPropagation()
            }} style={{ flexDirection: "row" }}>
              <TextInput
                style={{ textAlign: "center", backgroundColor: "white", flex: .5, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
                onChangeText={(e) => {
                  if (inputTimeout.current) clearTimeout(inputTimeout.current)

                  videoControlsSet(prev => {
                    const newNum = parseInt(e)
                    return {
                      ...prev,
                      amtToSegment: newNum
                    }
                  })
                }}
                value={`${isNaN(videoControls.amtToSegment) ? "" : videoControls.amtToSegment}`}
                keyboardType="numeric"
              />
            </Pressable>
          </Pressable>
        )}

        {runningVideoSplitInfo.running && (
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: 'center', backgroundColor: "rgba(0,0,0,0.2)" }}>
            <View style={{ backgroundColor: "#fff", padding: 32, gap: 8, }}>
              <Text>
                {runningVideoSplitInfo.duration ? `Completed in ${runningVideoSplitInfo.duration / 1000}s` : `Loading...`}
              </Text>

              <Text style={{ fontSize: 8, maxWidth: 100 }}>Note - scaling/rotating the video will take longer to process.</Text>

              {usingAFilter && (
                <Text style={{ fontSize: 8, maxWidth: 100 }}>Est. time to process {(((videoDuration / 1000) / 60) * 2.2).toFixed(1)} mintues</Text>
              )}

              {runningVideoSplitInfo.errorSeen && (
                <View>
                  <Button title='Close' color={"#A6B1E1"} onPress={() => {
                    runningVideoSplitInfoSet(prev => {
                      return { ...prev, running: false }
                    })
                  }} />

                  <Text>Errors Seen</Text>

                  <View>
                    {runningVideoSplitInfo.errorSeen.map((eachError, eachErrorIndex) => {
                      return (
                        <Text key={eachErrorIndex}>
                          {eachError}
                        </Text>
                      )
                    })}
                  </View>

                  <Button title='Try again' color={"#A6B1E1"} onPress={handleWantsToSplit} />
                </View>
              )}
            </View>
          </View>
        )}
      </View>

      <View style={{ flex: 1.5 }}>
        <ScrollView horizontal style={{ flex: 1 }}>
          {splitVideoUris.map((eachUri, eachUriIndex) => {

            return (
              <View key={eachUriIndex} style={{ backgroundColor: "#a6b1e1", flex: 1, width: 300, margin: 16, marginLeft: 0 }}>
                <TouchableOpacity style={{ marginLeft: "auto", padding: 8 }} onPress={() => { onShare([splitVideosOutputDir + eachUri], true) }}>
                  <ShareSvg width={20} height={20} />
                </TouchableOpacity>


                <Video
                  style={{ height: 150, flex: 1 }}
                  source={{ uri: splitVideosOutputDir + eachUri }}
                  useNativeControls
                  resizeMode={ResizeMode.CONTAIN}
                />
              </View>
            )
          })}
        </ScrollView>
      </View>

      <View style={{ backgroundColor: "hsl(288, 33%, 5%)", flex: 1, flexDirection: 'row', justifyContent: "center", alignItems: "center", gap: 16, borderTopColor: "#D6E5E3", borderTopWidth: 2 }}>
        {uploadedVideoInfo && (
          <TouchableOpacity activeOpacity={0.8} style={styles.settingsButton} onPress={handleWantsToSplit}>
            <Text style={styles.settingsButtonText}>split</Text>
          </TouchableOpacity>
        )}

        {splitVideoUris.length > 0 && (
          <TouchableOpacity activeOpacity={0.8} style={{ position: "relative", top: -40 }} onPress={() => { onShare(splitVideoUris.map(eachUri => splitVideosOutputDir + eachUri)) }}>
            <Image
              style={{ width: 120, height: 120, aspectRatio: "1/1", borderRadius: 8 }}
              source={require("./assets/share.png")}
            />
            <View style={{ backgroundColor: "#dcd6f7", position: "absolute", top: 0, left: 0, right: 0, bottom: 0, transform: [{ scale: 1.05 }], zIndex: -1, borderRadius: 30 }}></View>
          </TouchableOpacity>
        )}

        <TouchableOpacity activeOpacity={0.8} style={styles.settingsButton} onPress={uploadVideo}>
          <Text style={styles.settingsButtonText}>upload</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView >
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#242734',
    display: "flex",
    flexDirection: "column"
  },
  settingsContSmall: {
    backgroundColor: "#dcd6f7",
    borderRadius: 8,
    paddingVertical: 16
  },
  settingsButton: {
    padding: 16,
    aspectRatio: "1/1",
    alignItems: "center",
    justifyContent: 'center',
    borderRadius: 500,
    backgroundColor: "#D6E5E3",
  },
  settingsButtonText: {
    fontWeight: "bold",
    textTransform: "uppercase"
  },
  svg: {
    width: 25,
    height: 25
  }
});
